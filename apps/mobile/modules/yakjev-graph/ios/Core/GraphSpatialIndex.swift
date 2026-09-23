import Foundation

public struct GraphIndexedNode: Equatable, Sendable {
  public let id: String
  public let point: GraphPoint

  public init(id: String, point: GraphPoint) {
    self.id = id
    self.point = point
  }
}

/// Immutable uniform grid. Rebuild after layout updates; camera movement needs no rebuild.
public struct GraphSpatialIndex: Sendable {
  private struct Cell: Hashable, Sendable {
    let x: Int
    let y: Int
  }

  private let cells: [Cell: [GraphIndexedNode]]
  private let origin: GraphPoint
  private let bounds: GraphRect?
  public let cellSize: Double
  public let count: Int

  public init(nodes: [GraphIndexedNode], cellSize requestedSize: Double? = nil) {
    let validNodes = nodes.filter { $0.point.isFinite }
    count = validNodes.count
    guard let first = validNodes.first else {
      cells = [:]
      origin = .zero
      bounds = nil
      cellSize = 1
      return
    }
    var bounds = GraphRect(minX: first.point.x, minY: first.point.y, maxX: first.point.x, maxY: first.point.y)
    for node in validNodes {
      bounds.minX = min(bounds.minX, node.point.x)
      bounds.maxX = max(bounds.maxX, node.point.x)
      bounds.minY = min(bounds.minY, node.point.y)
      bounds.maxY = max(bounds.maxY, node.point.y)
    }
    self.bounds = bounds
    origin = GraphPoint(x: bounds.minX, y: bounds.minY)
    let extent = max(bounds.width, bounds.height)
    let automaticSize = extent > 0 && extent.isFinite ? extent / max(1, sqrt(Double(count) / 16)) : 1
    if let requestedSize, requestedSize.isFinite, requestedSize > 0 {
      cellSize = requestedSize
    } else {
      cellSize = automaticSize > 0 ? automaticSize : Double.leastNormalMagnitude
    }
    var buckets: [Cell: [GraphIndexedNode]] = [:]
    buckets.reserveCapacity(max(1, count / 16))
    for node in validNodes {
      let cell = Cell(
        x: Self.coordinate((node.point.x - origin.x) / cellSize),
        y: Self.coordinate((node.point.y - origin.y) / cellSize)
      )
      buckets[cell, default: []].append(node)
    }
    cells = buckets
  }

  public func query(_ rect: GraphRect) -> [GraphIndexedNode] {
    var result: [GraphIndexedNode] = []
    visit(rect) { node in result.append(node) }
    return result
  }

  public func nearest(to point: GraphPoint, radius: Double) -> GraphIndexedNode? {
    guard point.isFinite, radius.isFinite, radius >= 0 else { return nil }
    var closest: GraphIndexedNode?
    var closestDistance = radius
    visit(GraphRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius)) { node in
      let distance = node.point.distance(to: point)
      if distance < closestDistance || (distance == closestDistance && (closest == nil || node.id < closest!.id)) {
        closest = node
        closestDistance = distance
      }
    }
    return closest
  }

  public func nearby(to point: GraphPoint, radius: Double, limit: Int, excluding: String? = nil) -> [GraphIndexedNode] {
    guard point.isFinite, radius.isFinite, radius >= 0, limit > 0 else { return [] }
    var result: [(node: GraphIndexedNode, distance: Double)] = []
    visit(GraphRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius)) { node in
      guard node.id != excluding else { return }
      let distance = node.point.distance(to: point)
      if distance <= radius { result.append((node, distance)) }
    }
    result.sort { lhs, rhs in lhs.distance == rhs.distance ? lhs.node.id < rhs.node.id : lhs.distance < rhs.distance }
    return result.prefix(limit).map(\.node)
  }

  private func visit(_ rect: GraphRect, body: (GraphIndexedNode) -> Void) {
    guard let bounds, bounds.intersects(rect) else { return }
    // Clamp to indexed bounds before calculating cell coordinates; far zoomed-out cameras
    // must not walk billions of empty cells.
    let minX = Self.coordinate((max(bounds.minX, rect.minX) - origin.x) / cellSize)
    let minY = Self.coordinate((max(bounds.minY, rect.minY) - origin.y) / cellSize)
    let maxX = Self.coordinate((min(bounds.maxX, rect.maxX) - origin.x) / cellSize)
    let maxY = Self.coordinate((min(bounds.maxY, rect.maxY) - origin.y) / cellSize)
    let candidateCells = (Double(maxX) - Double(minX) + 1) * (Double(maxY) - Double(minY) + 1)
    if candidateCells > Double(cells.count) {
      for (cell, bucket) in cells where cell.x >= minX && cell.x <= maxX && cell.y >= minY && cell.y <= maxY {
        for node in bucket where rect.contains(node.point) { body(node) }
      }
    } else {
      for x in minX...maxX {
        for y in minY...maxY {
          if let bucket = cells[Cell(x: x, y: y)] {
            for node in bucket where rect.contains(node.point) { body(node) }
          }
        }
      }
    }
  }

  private static func coordinate(_ value: Double) -> Int {
    if value >= Double(Int.max) { return Int.max }
    if value <= Double(Int.min) { return Int.min }
    return value.isNaN ? 0 : Int(floor(value))
  }
}
