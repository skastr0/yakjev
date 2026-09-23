#if os(macOS)
import Foundation
import Metal
import XCTest

/// These structures deliberately mirror the ABI consumed by ios/Shaders/Graph.metal.
private struct ShaderCamera {
  var viewport: SIMD2<Float>
  var center: SIMD2<Float>
  var scale: Float
  var selectedNode: Int32
  var selectedEdge: Int32
  var connectSource: Int32
}

private struct ShaderEdge {
  var nodes: SIMD2<UInt32>
  var color: SIMD4<Float>
}

final class GraphMetalTests: XCTestCase {
  /// Opt in with YAKJEV_METAL_BENCHMARK=1. This measures the actual production
  /// shader's instanced draw workload on the host GPU, not iPhone frame rate.
  func testLargeGraphMetalBenchmark() throws {
    guard ProcessInfo.processInfo.environment["YAKJEV_METAL_BENCHMARK"] == "1" else {
      throw XCTSkip("Set YAKJEV_METAL_BENCHMARK=1 to run the host Metal benchmark.")
    }
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw XCTSkip("No Metal device is available; no benchmark was performed.")
    }
    let module = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    let shaderURL = module.appendingPathComponent("ios/Shaders/Graph.metal")
    let library = try device.makeLibrary(source: String(contentsOf: shaderURL, encoding: .utf8), options: nil)
    let nodePipeline = try pipeline(device: device, library: library, vertex: "graphNode", fragment: "graphDisc")
    let edgePipeline = try pipeline(device: device, library: library, vertex: "graphEdge", fragment: "graphLine")

    let nodeCount = 10_000
    let edgeCount = 30_000
    let viewport = SIMD2<Float>(390, 844)
    // Three pixels per point exercises a phone-sized drawable. These are host
    // offscreen dimensions; there is no simulator, display or present involved.
    let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .bgra8Unorm, width: 1170, height: 2532, mipmapped: false
    )
    textureDescriptor.storageMode = .private
    textureDescriptor.usage = .renderTarget
    let texture = try XCTUnwrap(device.makeTexture(descriptor: textureDescriptor))
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 245.0 / 255, green: 242.0 / 255, blue: 233.0 / 255, alpha: 1)

    var positions: [SIMD2<Float>] = (0..<nodeCount).map { i in
      SIMD2(12 + Float(i % 100) * 3.69, 14 + Float(i / 100) * 8.21)
    }
    let colors: [SIMD4<Float>] = (0..<nodeCount).map { i in
      SIMD4(0.1 + Float(i % 5) * 0.16, 0.25 + Float(i % 3) * 0.17, 0.8 - Float(i % 4) * 0.15, 1)
    }
    // Every edge exceeds the shader's 20-point minimum: horizontal spans,
    // vertical spans and long crossing links all survive the short-edge guard.
    let edgeRecords: [ShaderEdge] = (0..<edgeCount).map { i in
      let source = i / 3
      let offset = [7, 400, 4011][i % 3]
      return ShaderEdge(nodes: SIMD2(UInt32(source), UInt32((source + offset) % nodeCount)), color: SIMD4(0.25, 0.5, 0.38, 0.7))
    }
    for edge in edgeRecords {
      let delta = positions[Int(edge.nodes.x)] - positions[Int(edge.nodes.y)]
      XCTAssertGreaterThan(hypot(delta.x, delta.y) * 0.996, 20, "All 30,000 edges must survive the shader's short-edge guard.")
    }
    let positionBuffers = try (0..<3).map { _ in try buffer(device: device, values: positions) }
    let colorBuffer = try buffer(device: device, values: colors)
    let edgeBuffer = try buffer(device: device, values: edgeRecords)
    let queue = try XCTUnwrap(device.makeCommandQueue())
    let warmup = 10
    let samples = 60
    var cpu: [Double] = []
    var gpu: [Double] = []
    var wall: [Double] = []

    for sample in 0..<(warmup + samples) {
      try autoreleasepool {
        let positionBuffer = positionBuffers[sample % 3]
        // Exercise a native drag's 80 KB position upload as well as changing
        // pan/zoom uniforms. Geometry, buffers and pipelines stay allocated.
        positions[0].x = 12 + sin(Float(sample) * 0.2)
        var camera = ShaderCamera(
          viewport: viewport, center: viewport * 0.5 + SIMD2(sin(Float(sample) * 0.1), cos(Float(sample) * 0.1)),
          scale: 1 + sin(Float(sample) * 0.05) * 0.004,
          selectedNode: 0, selectedEdge: -1, connectSource: -1
        )
        let started = DispatchTime.now().uptimeNanoseconds
        positions.withUnsafeBytes { bytes in
          positionBuffer.contents().copyMemory(from: bytes.baseAddress!, byteCount: bytes.count)
        }
        let command = try XCTUnwrap(queue.makeCommandBuffer())
        let encoder = try XCTUnwrap(command.makeRenderCommandEncoder(descriptor: pass))
        encoder.setVertexBuffer(positionBuffer, offset: 0, index: 0)
        encoder.setVertexBytes(&camera, length: MemoryLayout<ShaderCamera>.stride, index: 2)
        encoder.setRenderPipelineState(edgePipeline)
        encoder.setVertexBuffer(edgeBuffer, offset: 0, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 9, instanceCount: edgeCount)
        encoder.setRenderPipelineState(nodePipeline)
        encoder.setVertexBuffer(colorBuffer, offset: 0, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6, instanceCount: nodeCount)
        encoder.endEncoding()
        let encoded = DispatchTime.now().uptimeNanoseconds
        command.commit()
        // Serialize samples deliberately: GPU execution duration and queue/wait
        // overhead are reported independently, without claiming display FPS.
        command.waitUntilCompleted()
        let completed = DispatchTime.now().uptimeNanoseconds
        XCTAssertEqual(command.status, .completed, "Metal command failed: \(String(describing: command.error))")
        if sample >= warmup {
          let gpuSeconds = command.gpuEndTime - command.gpuStartTime
          XCTAssertGreaterThan(gpuSeconds, 0, "The GPU must provide real command timestamps.")
          cpu.append(Double(encoded - started) / 1_000_000)
          gpu.append(gpuSeconds * 1_000)
          wall.append(Double(completed - started) / 1_000_000)
        }
      }
    }
    let report: [String: Any] = [
      "scope": "macOS offscreen production Metal shader; not device FPS",
      "device": device.name,
      "os": ProcessInfo.processInfo.operatingSystemVersionString,
      "nodes": nodeCount,
      "edges": edgeCount,
      "drawablePixels": [1170, 2532],
      "viewportPoints": [390, 844],
      "warmupFrames": warmup,
      "measuredFrames": samples,
      "drawCallsPerFrame": 2,
      "positionUploadBytesPerFrame": positions.count * MemoryLayout<SIMD2<Float>>.stride,
      "cpuEncodeMs": statistics(cpu),
      "gpuExecutionMs": statistics(gpu),
      "encodeThroughCompletionMs": statistics(wall),
      "excluded": ["shader compilation", "graph construction", "buffer allocation", "CoreGraphics labels", "React Native/JS", "display presentation"],
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    print("YAKJEV_METAL_BENCHMARK \(String(decoding: data, as: UTF8.self))")
  }

  private func statistics(_ values: [Double]) -> [String: Double] {
    let ordered = values.sorted()
    return [
      "mean": values.reduce(0, +) / Double(values.count),
      "median": (ordered[(ordered.count - 1) / 2] + ordered[ordered.count / 2]) / 2,
      "p95": ordered[Int(ceil(Double(ordered.count) * 0.95)) - 1],
      "min": ordered[0],
      "max": ordered[ordered.count - 1],
    ]
  }

  func testProductionShaderRendersNodesDirectedEdgeAndPaper() throws {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw XCTSkip("No Metal device is available; actual shader rendering was not verified.")
    }

    XCTAssertEqual(MemoryLayout<ShaderCamera>.stride, 32)
    XCTAssertEqual(MemoryLayout<ShaderCamera>.offset(of: \.center), 8)
    XCTAssertEqual(MemoryLayout<ShaderCamera>.offset(of: \.scale), 16)
    XCTAssertEqual(MemoryLayout<ShaderCamera>.offset(of: \.selectedNode), 20)
    XCTAssertEqual(MemoryLayout<ShaderCamera>.offset(of: \.selectedEdge), 24)
    XCTAssertEqual(MemoryLayout<ShaderCamera>.offset(of: \.connectSource), 28)
    XCTAssertEqual(MemoryLayout<ShaderEdge>.stride, 32)
    XCTAssertEqual(MemoryLayout<ShaderEdge>.offset(of: \.color), 16)

    // Compile the real production shader rather than copying its implementation into the test.
    let module = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    let shaderURL = module.appendingPathComponent("ios/Shaders/Graph.metal")
    let library = try device.makeLibrary(source: String(contentsOf: shaderURL, encoding: .utf8), options: nil)
    let nodes = try pipeline(device: device, library: library, vertex: "graphNode", fragment: "graphDisc")
    let edges = try pipeline(device: device, library: library, vertex: "graphEdge", fragment: "graphLine")

    let width = 128
    let height = 96
    let bytesPerRow = width * 4
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false
    )
    descriptor.storageMode = .private
    descriptor.usage = .renderTarget
    let texture = try XCTUnwrap(device.makeTexture(descriptor: descriptor))
    let readback = try XCTUnwrap(device.makeBuffer(length: bytesPerRow * height, options: .storageModeShared))
    let queue = try XCTUnwrap(device.makeCommandQueue())
    let command = try XCTUnwrap(queue.makeCommandBuffer())
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 245.0 / 255, green: 242.0 / 255, blue: 233.0 / 255, alpha: 1)

    // Nonzero camera center and scale exercise the actual world-to-clip transform.
    let positions: [SIMD2<Float>] = [SIMD2(-15, 5), SIMD2(25, 5)]
    let colors: [SIMD4<Float>] = [SIMD4(0.8, 0.12, 0.05, 1), SIMD4(0.1, 0.25, 0.85, 1)]
    let edgeRecords = [ShaderEdge(nodes: SIMD2(0, 1), color: SIMD4(0.1, 0.65, 0.3, 1))]
    let positionBuffer = try buffer(device: device, values: positions)
    let colorBuffer = try buffer(device: device, values: colors)
    let edgeBuffer = try buffer(device: device, values: edgeRecords)
    var camera = ShaderCamera(
      viewport: SIMD2(Float(width), Float(height)), center: SIMD2(5, 5), scale: 2,
      selectedNode: -1, selectedEdge: 0, connectSource: -1
    )
    let encoder = try XCTUnwrap(command.makeRenderCommandEncoder(descriptor: pass))
    encoder.setVertexBuffer(positionBuffer, offset: 0, index: 0)
    encoder.setVertexBytes(&camera, length: MemoryLayout<ShaderCamera>.stride, index: 2)
    encoder.setRenderPipelineState(edges)
    encoder.setVertexBuffer(edgeBuffer, offset: 0, index: 1)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 9, instanceCount: 1)
    encoder.setRenderPipelineState(nodes)
    encoder.setVertexBuffer(colorBuffer, offset: 0, index: 1)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6, instanceCount: 2)
    encoder.endEncoding()

    let blit = try XCTUnwrap(command.makeBlitCommandEncoder())
    blit.copy(
      from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
      sourceSize: MTLSize(width: width, height: height, depth: 1), to: readback, destinationOffset: 0,
      destinationBytesPerRow: bytesPerRow, destinationBytesPerImage: bytesPerRow * height
    )
    blit.endEncoding()
    command.commit()
    command.waitUntilCompleted()
    XCTAssertEqual(command.status, .completed, "Metal command failed: \(String(describing: command.error))")

    let pixels = readback.contents().bindMemory(to: UInt8.self, capacity: bytesPerRow * height)
    assertPixel(pixels, bytesPerRow: bytesPerRow, x: 24, y: 48, rgb: (204, 31, 13))
    assertPixel(pixels, bytesPerRow: bytesPerRow, x: 104, y: 48, rgb: (26, 64, 217))
    assertPixel(pixels, bytesPerRow: bytesPerRow, x: 64, y: 48, rgb: (26, 166, 77))
    // This pixel is outside the line's width, so only the arrow triangle can color it.
    assertPixel(pixels, bytesPerRow: bytesPerRow, x: 91, y: 46, rgb: (26, 166, 77))
    assertPixel(pixels, bytesPerRow: bytesPerRow, x: 4, y: 4, rgb: (245, 242, 233))
    assertPixel(pixels, bytesPerRow: bytesPerRow, x: 24, y: 57, rgb: (245, 242, 233))
    assertPixel(pixels, bytesPerRow: bytesPerRow, x: 35, y: 46, rgb: (245, 242, 233))
  }

  private func pipeline(device: MTLDevice, library: MTLLibrary, vertex: String, fragment: String) throws -> MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = try XCTUnwrap(library.makeFunction(name: vertex))
    descriptor.fragmentFunction = try XCTUnwrap(library.makeFunction(name: fragment))
    let attachment = try XCTUnwrap(descriptor.colorAttachments[0])
    attachment.pixelFormat = .bgra8Unorm
    attachment.isBlendingEnabled = true
    attachment.sourceRGBBlendFactor = .sourceAlpha
    attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
    attachment.sourceAlphaBlendFactor = .one
    attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
    return try device.makeRenderPipelineState(descriptor: descriptor)
  }

  private func buffer<Value>(device: MTLDevice, values: [Value]) throws -> MTLBuffer {
    try values.withUnsafeBytes { bytes in
      try XCTUnwrap(device.makeBuffer(bytes: XCTUnwrap(bytes.baseAddress), length: bytes.count, options: .storageModeShared))
    }
  }

  private func assertPixel(
    _ pixels: UnsafeMutablePointer<UInt8>, bytesPerRow: Int, x: Int, y: Int, rgb: (Int, Int, Int),
    file: StaticString = #filePath, line: UInt = #line
  ) {
    let offset = y * bytesPerRow + x * 4
    let actual = (Int(pixels[offset + 2]), Int(pixels[offset + 1]), Int(pixels[offset]))
    for (value, expected) in [(actual.0, rgb.0), (actual.1, rgb.1), (actual.2, rgb.2)] {
      XCTAssertLessThanOrEqual(abs(value - expected), 1, "Pixel (\(x),\(y)): got RGB \(actual), expected \(rgb)", file: file, line: line)
    }
    XCTAssertEqual(pixels[offset + 3], 255, "Pixel (\(x),\(y)) must be opaque", file: file, line: line)
  }
}
#endif
