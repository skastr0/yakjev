import ExpoModulesCore
import MetalKit
import UIKit

final class YakjevGraphView: ExpoView, UIGestureRecognizerDelegate {
  let onNodePress = EventDispatcher()
  let onEdgePress = EventDispatcher()
  let onCanvasPress = EventDispatcher()
  let onNodeDrag = EventDispatcher()
  let onConnect = EventDispatcher()
  let onRendererError = EventDispatcher()

  var selectedNodeId = ""
  var selectedEdgeId = ""
  var connectSourceId = ""
  var focusNodeId = ""
  var fitRequest = 0
  var interactive = true

  private let metalView = MTKView(frame: .zero, device: nil)
  private let labels = GraphLabelOverlay(frame: .zero)
  private var renderer: GraphMetalRenderer?
  private var rendererError: String?
  private var didReportError = false
  private var nodes: [YakjevNodeRecord] = []
  private var edges: [YakjevEdgeRecord] = []
  private var ghosts: [YakjevEdgeRecord] = []
  private var validEdges: [YakjevEdgeRecord] = []
  private var nodeIndex: [String: Int] = [:]
  private var spatialIndex = GraphSpatialIndex(nodes: [])
  private var points: [GraphPoint] = []
  private var nodeLabels: [String: CGSize] = [:]
  private var edgeLabels: [String: CGSize] = [:]
  private var graphDirty = true
  private var edgesDirty = true
  private var hasFitted = false
  private var lastFitRequest: Int?
  private var lastFocus = ""
  private var camera = GraphCamera()
  private var draggingNodeId: String?
  private var dragStart: GraphPoint?
  private var dragTouchOffset = GraphPoint.zero
  private var lastDragEmission: CFTimeInterval = 0
  private var connectingSource: String?
  private var connectionPoint: CGPoint?
  private var lastPan = CGPoint.zero
  private var lastPinch: CGFloat = 1
  private var pinchStart: CGPoint?
  private var refreshScheduled = false
  private var nodeFont = UIFont(name: "AvenirNext-Regular", size: 13) ?? .systemFont(ofSize: 13)
  private var edgeFont = UIFont(name: "AvenirNext-Regular", size: 10) ?? .systemFont(ofSize: 10)
  private let ink = UIColor(red: 32.0 / 255, green: 61.0 / 255, blue: 53.0 / 255, alpha: 1)
  private let muted = UIColor(red: 86.0 / 255, green: 104.0 / 255, blue: 83.0 / 255, alpha: 1)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = GraphLabelOverlay.paper
    addSubview(metalView)
    addSubview(labels)
    do { renderer = try GraphMetalRenderer(view: metalView) }
    catch {
      rendererError = error.localizedDescription
      let errorLabel = UILabel()
      errorLabel.text = "The graph renderer could not start. \(error.localizedDescription)"
      errorLabel.numberOfLines = 0
      errorLabel.textColor = ink
      errorLabel.font = nodeFont
      errorLabel.translatesAutoresizingMaskIntoConstraints = false
      addSubview(errorLabel)
      NSLayoutConstraint.activate([
        errorLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
        errorLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
        errorLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
      ])
    }
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
    pan.maximumNumberOfTouches = 1
    pan.delegate = self
    pinch.delegate = self
    addGestureRecognizer(tap)
    addGestureRecognizer(pan)
    addGestureRecognizer(pinch)
    isAccessibilityElement = false
    NotificationCenter.default.addObserver(self, selector: #selector(contentSizeChanged), name: UIContentSizeCategory.didChangeNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(voiceOverChanged), name: UIAccessibility.voiceOverStatusDidChangeNotification, object: nil)
    contentSizeChanged()
  }

  deinit { NotificationCenter.default.removeObserver(self) }

  func setNodes(_ value: [YakjevNodeRecord]) {
    // Ignore malformed positions and duplicate IDs at the native boundary.
    var seen = Set<String>()
    nodes = value.filter { !$0.id.isEmpty && $0.x.isFinite && $0.y.isFinite && abs($0.x) < 1e20 && abs($0.y) < 1e20 && seen.insert($0.id).inserted }
    graphDirty = true
    edgesDirty = true
  }

  func setEdges(_ value: [YakjevEdgeRecord]) { edges = value; edgesDirty = true }
  func setGhostEdges(_ value: [YakjevEdgeRecord]) { ghosts = value; edgesDirty = true }

  func applyProps() {
    if let rendererError, !didReportError {
      didReportError = true
      onRendererError(["message": rendererError])
    }
    if graphDirty {
      let interval = GraphMetalRenderer.signposter.beginInterval("UpdateGraph", id: GraphMetalRenderer.signposter.makeSignpostID())
      let draggedPoint = draggingNodeId.flatMap { nodeIndex[$0] }.flatMap { points.indices.contains($0) ? points[$0] : nil }
      nodeIndex = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, $0.offset) })
      points = nodes.map { GraphPoint(x: $0.x, y: $0.y) }
      if let id = draggingNodeId, let index = nodeIndex[id], let draggedPoint { points[index] = draggedPoint }
      rebuildIndex()
      nodeLabels.removeAll(keepingCapacity: true)
      renderer?.setNodes(positions: points.map { SIMD2(Float($0.x), Float($0.y)) }, colors: nodes.map { Self.color($0.color) })
      graphDirty = false
      GraphMetalRenderer.signposter.endInterval("UpdateGraph", interval)
    }
    if edgesDirty {
      validEdges = edges.filter { nodeIndex[$0.source] != nil && nodeIndex[$0.target] != nil }
      renderer?.setEdges(validEdges.compactMap { metalEdge($0, ghost: false) }, ghosts: ghosts.compactMap { metalEdge($0, ghost: true) })
      edgeLabels.removeAll(keepingCapacity: true)
      edgesDirty = false
    }
    if !hasFitted || lastFitRequest != fitRequest { fit() }
    if focusNodeId != lastFocus, let index = nodeIndex[focusNodeId] {
      camera.center = points[index]
      lastFocus = focusNodeId
    } else if focusNodeId.isEmpty { lastFocus = "" }
    renderer?.selectedNode = Int32(nodeIndex[selectedNodeId] ?? -1)
    renderer?.selectedEdge = Int32(validEdges.firstIndex { $0.id == selectedEdgeId } ?? -1)
    renderer?.connectSource = Int32(nodeIndex[connectSourceId] ?? -1)
    scheduleRefresh()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    metalView.frame = bounds
    labels.frame = bounds
    camera.viewportWidth = Double(bounds.width)
    camera.viewportHeight = Double(bounds.height)
    if !hasFitted { fit() }
    scheduleRefresh()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { scheduleRefresh() }
  }

  private func fit() {
    guard bounds.width > 0, bounds.height > 0, !points.isEmpty else { return }
    camera.fit(points: points, padding: min(72, Double(bounds.width) * 0.18))
    hasFitted = true
    lastFitRequest = fitRequest
  }

  private func rebuildIndex() {
    spatialIndex = GraphSpatialIndex(nodes: nodes.enumerated().map { GraphIndexedNode(id: $0.element.id, point: points[$0.offset]) })
  }

  private func metalEdge(_ edge: YakjevEdgeRecord, ghost: Bool) -> GraphMetalEdge? {
    guard let source = nodeIndex[edge.source], let target = nodeIndex[edge.target] else { return nil }
    return GraphMetalEdge(nodes: SIMD2(UInt32(source), UInt32(target)), color: ghost ? SIMD4(111.0 / 255, 82.0 / 255, 237.0 / 255, 0.7) : Self.color(edge.color))
  }

  private static func color(_ hex: String) -> SIMD4<Float> {
    let value = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard value.count == 6, let rgb = UInt32(value, radix: 16) else { return SIMD4(0.17, 0.52, 1, 1) }
    return SIMD4(Float((rgb >> 16) & 255) / 255, Float((rgb >> 8) & 255) / 255, Float(rgb & 255) / 255, 1)
  }

  private func scheduleRefresh() {
    guard !refreshScheduled else { return }
    refreshScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.refreshScheduled = false
      self.renderer?.camera = self.camera
      self.updateLabels()
      self.metalView.setNeedsDisplay()
      self.labels.setNeedsDisplay()
    }
  }

  private func node(at screen: CGPoint) -> String? {
    let point = camera.screenToWorld(GraphPoint(x: Double(screen.x), y: Double(screen.y)))
    if let draggingNodeId, let index = nodeIndex[draggingNodeId] {
      let drawn = camera.worldToScreen(points[index])
      if hypot(drawn.x - Double(screen.x), drawn.y - Double(screen.y)) <= 24 { return draggingNodeId }
    }
    return spatialIndex.nearest(to: point, radius: 24 / camera.scale)?.id
  }

  private func emitNodePress(_ id: String) {
    guard interactive else { return }
    if !connectSourceId.isEmpty, connectSourceId != id { onConnect(["source": connectSourceId, "target": id]) }
    else { onNodePress(["id": id]) }
  }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    guard interactive else { return }
    let location = gesture.location(in: self)
    if let id = node(at: location) { emitNodePress(id); return }
    let point = camera.screenToWorld(GraphPoint(x: Double(location.x), y: Double(location.y)))
    let radius = 12 / camera.scale
    var closest: (String, Double)?
    for edge in validEdges {
      guard let a = nodeIndex[edge.source], let b = nodeIndex[edge.target] else { continue }
      let distance = GraphGeometry.distanceToSegment(point, start: points[a], end: points[b])
      if distance <= radius, distance < (closest?.1 ?? .infinity) { closest = (edge.id, distance) }
    }
    if let closest { onEdgePress(["id": closest.0]) }
    else { onCanvasPress(["x": point.x, "y": point.y]) }
  }

  @objc private func panned(_ gesture: UIPanGestureRecognizer) {
    guard interactive else { return }
    let location = gesture.location(in: self)
    let translation = gesture.translation(in: self)
    switch gesture.state {
    case .began:
      // UIKit begins after its movement threshold, so hit test the original
      // touch rather than the already-moved location.
      let initial = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
      lastPan = .zero
      if let id = node(at: initial), let index = nodeIndex[id] {
        if !connectSourceId.isEmpty {
          connectingSource = connectSourceId
          connectionPoint = location
        } else {
          draggingNodeId = id
          dragStart = points[index]
          let touch = camera.screenToWorld(GraphPoint(x: Double(initial.x), y: Double(initial.y)))
          dragTouchOffset = GraphPoint(x: points[index].x - touch.x, y: points[index].y - touch.y)
          emitDrag(phase: "start")
        }
      }
      updatePan(location: location, translation: translation)
    case .changed:
      updatePan(location: location, translation: translation)
    case .ended, .cancelled, .failed:
      let cancelled = gesture.state != .ended
      if let source = connectingSource, !cancelled, let target = node(at: location), source != target {
        onConnect(["source": source, "target": target])
      }
      if let id = draggingNodeId, let index = nodeIndex[id] {
        if cancelled, let start = dragStart { points[index] = start; renderer?.moveNode(index: index, point: start) }
        emitDrag(phase: cancelled ? "cancel" : "end")
        rebuildIndex()
      }
      draggingNodeId = nil
      dragStart = nil
      connectingSource = nil
      connectionPoint = nil
      scheduleRefresh()
    default: break
    }
  }

  private func updatePan(location: CGPoint, translation: CGPoint) {
    if connectingSource != nil { connectionPoint = location }
    else if let id = draggingNodeId, let index = nodeIndex[id] {
      let touch = camera.screenToWorld(GraphPoint(x: Double(location.x), y: Double(location.y)))
      let point = GraphPoint(x: touch.x + dragTouchOffset.x, y: touch.y + dragTouchOffset.y)
      points[index] = point
      renderer?.moveNode(index: index, point: point)
      let now = CACurrentMediaTime()
      if now - lastDragEmission >= 0.1 { emitDrag(phase: "move") }
    } else {
      camera.pan(delta: GraphPoint(x: Double(translation.x - lastPan.x), y: Double(translation.y - lastPan.y)))
    }
    lastPan = translation
    scheduleRefresh()
  }

  private func emitDrag(phase: String) {
    guard let id = draggingNodeId, let index = nodeIndex[id] else { return }
    let point = points[index]
    let nearby = spatialIndex.nearby(to: point, radius: 240 / camera.scale, limit: 24, excluding: id).map(\.id)
    onNodeDrag(["id": id, "x": point.x, "y": point.y, "nearbyIds": nearby, "phase": phase])
    lastDragEmission = CACurrentMediaTime()
  }

  @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
    guard interactive else { return }
    let location = gesture.location(in: self)
    switch gesture.state {
    case .began:
      lastPinch = 1
      pinchStart = location
    case .changed:
      let previous = pinchStart ?? location
      camera.zoom(factor: Double(gesture.scale / lastPinch), anchor: GraphPoint(x: Double(previous.x), y: Double(previous.y)))
      camera.pan(delta: GraphPoint(x: Double(location.x - previous.x), y: Double(location.y - previous.y)))
      lastPinch = gesture.scale
      pinchStart = location
      scheduleRefresh()
    case .ended, .cancelled, .failed: pinchStart = nil
    default: break
    }
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { false }

  @objc private func contentSizeChanged() {
    nodeFont = UIFontMetrics(forTextStyle: .caption1).scaledFont(for: UIFont(name: "AvenirNext-Regular", size: 13) ?? .systemFont(ofSize: 13), maximumPointSize: 22)
    edgeFont = UIFontMetrics(forTextStyle: .caption2).scaledFont(for: UIFont(name: "AvenirNext-Regular", size: 10) ?? .systemFont(ofSize: 10), maximumPointSize: 17)
    nodeLabels.removeAll()
    edgeLabels.removeAll()
    scheduleRefresh()
  }

  @objc private func voiceOverChanged() {
    if !UIAccessibility.isVoiceOverRunning { accessibilityElements = nil }
    scheduleRefresh()
  }

  private func updateLabels() {
    guard bounds.width > 0, bounds.height > 0 else { return }
    let interval = GraphMetalRenderer.signposter.beginInterval("VisibleLabels", id: GraphMetalRenderer.signposter.makeSignpostID())
    defer { GraphMetalRenderer.signposter.endInterval("VisibleLabels", interval) }
    var visible = spatialIndex.query(camera.visibleWorldRect.expanded(by: 24 / camera.scale))
    if let id = draggingNodeId, let index = nodeIndex[id] {
      visible.removeAll { $0.id == id }
      visible.insert(GraphIndexedNode(id: id, point: points[index]), at: 0)
    }
    visible.sort {
      if $0.id == selectedNodeId { return $1.id != selectedNodeId }
      if $1.id == selectedNodeId { return false }
      return hypot($0.point.x - camera.center.x, $0.point.y - camera.center.y) < hypot($1.point.x - camera.center.x, $1.point.y - camera.center.y)
    }
    var output: [GraphCanvasLabel] = []
    var occupied: [CGRect] = []
    // Discs remain entirely on the GPU. This budget caps CPU text layout at any
    // zoom, with selected nodes considered first and colliding labels omitted.
    for item in visible.prefix(180) {
      guard output.count < 64, let index = nodeIndex[item.id] else { break }
      let node = nodes[index]
      let size = nodeLabels[node.id] ?? Self.textSize(node.label, font: nodeFont, maximum: 180)
      nodeLabels[node.id] = size
      let screen = camera.worldToScreen(points[index])
      let label = GraphCanvasLabel(text: node.label, center: CGPoint(x: screen.x + 12 + size.width / 2, y: screen.y), size: size, font: nodeFont, color: ink)
      if !occupied.contains(where: { $0.intersects(label.bounds) }) {
        output.append(label)
        occupied.append(label.bounds)
      }
    }
    var edgeLabelCount = 0
    // Relation labels are useful only when enough screen space separates nodes.
    // Bound candidate work on very large graphs; selected relations always win.
    let relationCandidates = validEdges.first(where: { $0.id == selectedEdgeId }).map { [$0] } ?? []
    for edge in relationCandidates + Array(validEdges.prefix(3000)) {
      guard edgeLabelCount < 28 else { break }
      guard !edge.label.isEmpty, let ai = nodeIndex[edge.source], let bi = nodeIndex[edge.target] else { continue }
      let a = camera.worldToScreen(points[ai])
      let b = camera.worldToScreen(points[bi])
      let middle = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
      guard bounds.contains(middle) else { continue }
      let size = edgeLabels[edge.id] ?? Self.textSize(edge.label, font: edgeFont, maximum: 140)
      edgeLabels[edge.id] = size
      guard hypot(b.x - a.x, b.y - a.y) > size.width + 52 else { continue }
      var angle = atan2(b.y - a.y, b.x - a.x)
      if angle > .pi / 2 { angle -= .pi }
      if angle < -.pi / 2 { angle += .pi }
      let label = GraphCanvasLabel(text: edge.label, center: CGPoint(x: middle.x + sin(angle) * 9, y: middle.y - cos(angle) * 9), size: size, angle: angle, font: edgeFont, color: muted)
      if !occupied.contains(where: { $0.intersects(label.bounds) }) {
        output.append(label)
        occupied.append(label.bounds)
        edgeLabelCount += 1
      }
    }
    labels.labels = output
    if let source = connectingSource, let index = nodeIndex[source], let connectionPoint {
      let start = camera.worldToScreen(points[index])
      labels.connection = (CGPoint(x: start.x, y: start.y), connectionPoint)
    } else { labels.connection = nil }
    updateAccessibility(visible: visible)
  }

  private static func textSize(_ text: String, font: UIFont, maximum: CGFloat) -> CGSize {
    let measured = (text as NSString).size(withAttributes: [.font: font])
    return CGSize(width: min(maximum, ceil(measured.width)), height: ceil(font.lineHeight))
  }

  private func updateAccessibility(visible: [GraphIndexedNode]) {
    guard UIAccessibility.isVoiceOverRunning else { return }
    var elements: [UIAccessibilityElement] = []
    let overview = UIAccessibilityElement(accessibilityContainer: self)
    overview.accessibilityLabel = "Graph, \(nodes.count) nodes, \(validEdges.count) connections"
    overview.accessibilityHint = "Use actions to fit or zoom. Find can locate any node."
    overview.accessibilityFrameInContainerSpace = bounds
    overview.accessibilityCustomActions = [
      UIAccessibilityCustomAction(name: "Fit graph", target: self, selector: #selector(accessibilityFit)),
      UIAccessibilityCustomAction(name: "Zoom in", target: self, selector: #selector(accessibilityZoomIn)),
      UIAccessibilityCustomAction(name: "Zoom out", target: self, selector: #selector(accessibilityZoomOut)),
    ]
    elements.append(overview)
    for item in visible.prefix(100) {
      guard let index = nodeIndex[item.id] else { continue }
      let element = GraphNodeAccessibilityElement(accessibilityContainer: self)
      element.accessibilityLabel = nodes[index].label
      element.accessibilityTraits = item.id == selectedNodeId ? [.button, .selected] : .button
      element.accessibilityHint = connectSourceId.isEmpty ? "Open node details" : "Connect to this node"
      let point = camera.worldToScreen(points[index])
      element.accessibilityFrameInContainerSpace = CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44)
      element.activate = { [weak self] in self?.emitNodePress(item.id) }
      elements.append(element)
    }
    accessibilityElements = elements
  }

  @objc private func accessibilityFit() -> Bool { fit(); scheduleRefresh(); return true }
  @objc private func accessibilityZoomIn() -> Bool { accessibilityZoom(1.5) }
  @objc private func accessibilityZoomOut() -> Bool { accessibilityZoom(1 / 1.5) }
  private func accessibilityZoom(_ factor: Double) -> Bool {
    camera.zoom(factor: factor, anchor: GraphPoint(x: Double(bounds.midX), y: Double(bounds.midY)))
    scheduleRefresh()
    return true
  }
}
