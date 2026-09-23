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
