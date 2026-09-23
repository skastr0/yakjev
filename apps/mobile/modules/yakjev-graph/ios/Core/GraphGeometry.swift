import Foundation

public struct GraphPoint: Hashable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }

  public static let zero = GraphPoint(x: 0, y: 0)
  public var isFinite: Bool { x.isFinite && y.isFinite }
  public func distance(to other: GraphPoint) -> Double { hypot(x - other.x, y - other.y) }
}

public struct GraphRect: Equatable, Sendable {
  public var minX: Double
  public var minY: Double
  public var maxX: Double
  public var maxY: Double

  public init(minX: Double, minY: Double, maxX: Double, maxY: Double) {
    self.minX = min(minX, maxX)
    self.minY = min(minY, maxY)
    self.maxX = max(minX, maxX)
    self.maxY = max(minY, maxY)
  }

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.init(minX: x, minY: y, maxX: x + width, maxY: y + height)
  }

  public var width: Double { maxX - minX }
  public var height: Double { maxY - minY }
  public var center: GraphPoint {
    GraphPoint(x: minX + width / 2, y: minY + height / 2)
  }

  public func contains(_ point: GraphPoint) -> Bool {
    point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY
  }

  public func intersects(_ other: GraphRect) -> Bool {
    minX <= other.maxX && maxX >= other.minX && minY <= other.maxY && maxY >= other.minY
  }

  public func expanded(by padding: Double) -> GraphRect {
    GraphRect(minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding)
  }
}

/// World positions retain their layout precision; the camera alone converts them to screen points.
public struct GraphCamera: Equatable, Sendable {
  public var center: GraphPoint
  public var scale: Double
  public var viewportWidth: Double
  public var viewportHeight: Double

  public init(
    center: GraphPoint = .zero, scale: Double = 1,
    viewportWidth: Double = 1, viewportHeight: Double = 1
  ) {
    self.center = center.isFinite ? center : .zero
    self.scale = scale.isFinite && scale > 0 ? scale : 1
    self.viewportWidth = viewportWidth
    self.viewportHeight = viewportHeight
  }

  public func worldToScreen(_ point: GraphPoint) -> GraphPoint {
    GraphPoint(
      x: (point.x - center.x) * scale + viewportWidth / 2,
      y: (point.y - center.y) * scale + viewportHeight / 2
    )
  }

  public func screenToWorld(_ point: GraphPoint) -> GraphPoint {
    GraphPoint(
      x: (point.x - viewportWidth / 2) / scale + center.x,
      y: (point.y - viewportHeight / 2) / scale + center.y
    )
  }

  public var visibleWorldRect: GraphRect {
    let topLeft = screenToWorld(.zero)
    let bottomRight = screenToWorld(GraphPoint(x: viewportWidth, y: viewportHeight))
    return GraphRect(minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y)
  }

  public mutating func fit(points: [GraphPoint], padding: Double = 32) {
    guard viewportWidth.isFinite, viewportHeight.isFinite,
      viewportWidth > 0, viewportHeight > 0,
      let first = points.first(where: { $0.isFinite }) else { return }
    var bounds = GraphRect(minX: first.x, minY: first.y, maxX: first.x, maxY: first.y)
    for point in points where point.isFinite {
      bounds.minX = min(bounds.minX, point.x)
      bounds.maxX = max(bounds.maxX, point.x)
      bounds.minY = min(bounds.minY, point.y)
      bounds.maxY = max(bounds.maxY, point.y)
    }
    center = bounds.center
    let inset = padding.isFinite ? max(0, padding) : 0
    let availableWidth = max(viewportWidth - 2 * inset, min(1, viewportWidth))
    let availableHeight = max(viewportHeight - 2 * inset, min(1, viewportHeight))
    let horizontalScale = bounds.width > 0 ? availableWidth / bounds.width : Double.infinity
    let verticalScale = bounds.height > 0 ? availableHeight / bounds.height : Double.infinity
    let fittedScale = min(horizontalScale, verticalScale)
    if fittedScale.isFinite && fittedScale > 0 { scale = fittedScale }
  }

  /// Delta is measured in screen points, in the direction the content should move.
  public mutating func pan(delta: GraphPoint) {
    guard delta.isFinite, scale.isFinite, scale > 0 else { return }
    center.x -= delta.x / scale
    center.y -= delta.y / scale
  }

  /// The world point under the screen-space anchor remains fixed throughout a pinch.
  public mutating func zoom(factor: Double, anchor: GraphPoint) {
    let nextScale = scale * factor
    guard factor.isFinite, factor > 0, nextScale.isFinite, nextScale > 0, anchor.isFinite else { return }
    let fixed = screenToWorld(anchor)
    scale = nextScale
    center = GraphPoint(
      x: fixed.x - (anchor.x - viewportWidth / 2) / scale,
      y: fixed.y - (anchor.y - viewportHeight / 2) / scale
    )
  }
}

public enum GraphGeometry {
  public static func distanceToSegment(_ point: GraphPoint, start: GraphPoint, end: GraphPoint) -> Double {
    let length = start.distance(to: end)
    guard length > 0 else { return point.distance(to: start) }
    let directionX = (end.x - start.x) / length
    let directionY = (end.y - start.y) / length
    let projection = min(length, max(0, (point.x - start.x) * directionX + (point.y - start.y) * directionY))
    return hypot(point.x - start.x - projection * directionX, point.y - start.y - projection * directionY)
  }

  public static func hitTestSegment(_ point: GraphPoint, start: GraphPoint, end: GraphPoint, radius: Double) -> Bool {
    radius >= 0 && distanceToSegment(point, start: start, end: end) <= radius
  }

  /// Slab clipping includes edges crossing the viewport even when both endpoints lie outside it.
  public static func segmentIntersectsRect(start: GraphPoint, end: GraphPoint, rect: GraphRect) -> Bool {
    guard start.isFinite, end.isFinite else { return false }
    var lower = 0.0
    var upper = 1.0
    for (origin, delta, minimum, maximum) in [
      (start.x, end.x - start.x, rect.minX, rect.maxX),
      (start.y, end.y - start.y, rect.minY, rect.maxY),
    ] {
      if delta == 0 {
        if origin < minimum || origin > maximum { return false }
      } else {
        let first = (minimum - origin) / delta
        let second = (maximum - origin) / delta
        lower = max(lower, min(first, second))
        upper = min(upper, max(first, second))
        if lower > upper { return false }
      }
    }
    return true
  }
}
