import MetalKit
import os

struct GraphMetalEdge {
  var nodes: SIMD2<UInt32>
  var color: SIMD4<Float>
}

private struct GraphMetalCamera {
  var viewport: SIMD2<Float>
  var center: SIMD2<Float>
  var scale: Float
  var selectedNode: Int32
  var selectedEdge: Int32
  var connectSource: Int32
}

/// Instanced geometry keeps graph size out of UIKit's view tree. Only positions
/// change while dragging; pan/zoom update a 32-byte camera uniform.
final class GraphMetalRenderer: NSObject, MTKViewDelegate {
  static let signposter = OSSignposter(subsystem: "com.yakjev.mobile", category: "Graph")
  private let device: MTLDevice
  private let queue: MTLCommandQueue
  private let nodePipeline: MTLRenderPipelineState
  private let edgePipeline: MTLRenderPipelineState
  private let frames = DispatchSemaphore(value: 3)
  private var frameIndex = 0
  private var positionBuffers: [MTLBuffer] = []
  private var colorBuffer: MTLBuffer?
  private var edgeBuffer: MTLBuffer?
  private var ghostBuffer: MTLBuffer?
  private var edgeCount = 0
  private var ghostCount = 0
  private var positions: [SIMD2<Float>] = []
  private var positionGeneration: UInt64 = 1
  private var bufferGenerations: [UInt64] = [0, 0, 0]
  var camera = GraphCamera()
  var selectedNode: Int32 = -1
  var selectedEdge: Int32 = -1
  var connectSource: Int32 = -1

  init(view: MTKView) throws {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
      throw GraphRendererError.unavailable("Metal is unavailable on this device.")
    }
    self.device = device
    self.queue = queue
    let bundle = Bundle(for: GraphMetalRenderer.self)
    guard let url = bundle.url(forResource: "YakjevGraphShaders", withExtension: "bundle")
      ?? Bundle.main.url(forResource: "YakjevGraphShaders", withExtension: "bundle"),
      let resources = Bundle(url: url) else {
      throw GraphRendererError.unavailable("The graph's bundled Metal shader is missing.")
    }
    let interval = Self.signposter.beginInterval("CompileShaders", id: Self.signposter.makeSignpostID())
    defer { Self.signposter.endInterval("CompileShaders", interval) }
    let library: MTLLibrary
    if let compiled = resources.url(forResource: "default", withExtension: "metallib") {
      library = try device.makeLibrary(URL: compiled)
    } else if let sourceURL = resources.url(forResource: "Graph", withExtension: "metal") {
      library = try device.makeLibrary(source: String(contentsOf: sourceURL, encoding: .utf8), options: nil)
    } else {
      throw GraphRendererError.unavailable("The graph's bundled Metal shader is missing.")
    }
    nodePipeline = try Self.pipeline(device: device, library: library, vertex: "graphNode", fragment: "graphDisc")
    edgePipeline = try Self.pipeline(device: device, library: library, vertex: "graphEdge", fragment: "graphLine")
    super.init()
    view.device = device
    view.delegate = self
    view.colorPixelFormat = .bgra8Unorm
    view.clearColor = MTLClearColor(red: 245.0 / 255, green: 242.0 / 255, blue: 233.0 / 255, alpha: 1)
    view.isOpaque = true
    view.isPaused = true
    view.enableSetNeedsDisplay = true
    view.autoResizeDrawable = true
    view.framebufferOnly = true
  }

  private static func pipeline(device: MTLDevice, library: MTLLibrary, vertex: String, fragment: String) throws -> MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: vertex)
    descriptor.fragmentFunction = library.makeFunction(name: fragment)
    descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    descriptor.colorAttachments[0].isBlendingEnabled = true
    descriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
    descriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
    descriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
    descriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
    return try device.makeRenderPipelineState(descriptor: descriptor)
  }

  func setNodes(positions: [SIMD2<Float>], colors: [SIMD4<Float>]) {
    self.positions = positions
    positionGeneration &+= 1
    if positionBuffers.first?.length != max(1, positions.count) * MemoryLayout<SIMD2<Float>>.stride {
      positionBuffers = (0..<3).compactMap { _ in
        device.makeBuffer(length: max(1, positions.count) * MemoryLayout<SIMD2<Float>>.stride, options: .storageModeShared)
      }
      bufferGenerations = [0, 0, 0]
    }
    colorBuffer = Self.buffer(device: device, values: colors)
  }

  func setEdges(_ edges: [GraphMetalEdge], ghosts: [GraphMetalEdge]) {
    edgeCount = edges.count
    ghostCount = ghosts.count
    edgeBuffer = Self.buffer(device: device, values: edges)
    ghostBuffer = Self.buffer(device: device, values: ghosts)
  }

  func moveNode(index: Int, point: GraphPoint) {
    guard positions.indices.contains(index) else { return }
    positions[index] = SIMD2(Float(point.x), Float(point.y))
    positionGeneration &+= 1
  }

  private static func buffer<T>(device: MTLDevice, values: [T]) -> MTLBuffer? {
    guard !values.isEmpty else { return nil }
    return values.withUnsafeBytes { bytes in
      guard let base = bytes.baseAddress else { return nil }
      return device.makeBuffer(bytes: base, length: bytes.count, options: .storageModeShared)
    }
  }

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

  func draw(in view: MTKView) {
    guard view.bounds.width > 0, view.bounds.height > 0, let descriptor = view.currentRenderPassDescriptor,
      let drawable = view.currentDrawable, let command = queue.makeCommandBuffer() else { return }
    // Never block the main thread behind the GPU. Retry after an in-flight frame
    // finishes if all three snapshots are currently occupied.
    guard frames.wait(timeout: .now()) == .success else {
      view.setNeedsDisplay()
      return
    }
    let interval = Self.signposter.beginInterval("EncodeFrame", id: Self.signposter.makeSignpostID())
    defer { Self.signposter.endInterval("EncodeFrame", interval) }
    let slot = frameIndex % 3
    guard let encoder = command.makeRenderCommandEncoder(descriptor: descriptor) else {
      frames.signal()
      return
    }
    frameIndex += 1
    if !positions.isEmpty, positionBuffers.count == 3, let colorBuffer {
      let positionBuffer = positionBuffers[slot]
      if bufferGenerations[slot] != positionGeneration {
        positions.withUnsafeBytes { bytes in
          if let base = bytes.baseAddress { positionBuffer.contents().copyMemory(from: base, byteCount: bytes.count) }
        }
        bufferGenerations[slot] = positionGeneration
      }
      var uniforms = GraphMetalCamera(
        viewport: SIMD2(Float(view.bounds.width), Float(view.bounds.height)),
        center: SIMD2(Float(camera.center.x), Float(camera.center.y)), scale: Float(camera.scale),
        selectedNode: selectedNode, selectedEdge: selectedEdge, connectSource: connectSource
      )
      encoder.setVertexBuffer(positionBuffer, offset: 0, index: 0)
      encoder.setVertexBytes(&uniforms, length: MemoryLayout<GraphMetalCamera>.stride, index: 2)
      encoder.setRenderPipelineState(edgePipeline)
      if let edgeBuffer, edgeCount > 0 {
        encoder.setVertexBuffer(edgeBuffer, offset: 0, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 9, instanceCount: edgeCount)
      }
      if let ghostBuffer, ghostCount > 0 {
        var ghostUniforms = uniforms
        ghostUniforms.selectedEdge = -1
        encoder.setVertexBytes(&ghostUniforms, length: MemoryLayout<GraphMetalCamera>.stride, index: 2)
        encoder.setVertexBuffer(ghostBuffer, offset: 0, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 9, instanceCount: ghostCount)
      }
      encoder.setVertexBytes(&uniforms, length: MemoryLayout<GraphMetalCamera>.stride, index: 2)
      encoder.setRenderPipelineState(nodePipeline)
      encoder.setVertexBuffer(colorBuffer, offset: 0, index: 1)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6, instanceCount: positions.count)
    }
    encoder.endEncoding()
    command.present(drawable)
    let frames = frames
    command.addCompletedHandler { buffer in
      Self.signposter.emitEvent("GPUComplete", "duration=\(buffer.gpuEndTime - buffer.gpuStartTime)")
      frames.signal()
    }
    command.commit()
  }
}

private enum GraphRendererError: LocalizedError {
  case unavailable(String)
  var errorDescription: String? { if case let .unavailable(message) = self { return message }; return nil }
}
