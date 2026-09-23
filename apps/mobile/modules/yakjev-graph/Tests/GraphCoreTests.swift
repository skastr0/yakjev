import XCTest
@testable import YakjevGraphCore

final class GraphCoreTests: XCTestCase {
  func testCameraRoundTripAndPan() {
    var camera = GraphCamera(center: GraphPoint(x: 15, y: -8), scale: 2.5, viewportWidth: 390, viewportHeight: 844)
    let point = GraphPoint(x: 9, y: 120)
    let originalScreen = camera.worldToScreen(point)
    assertPoint(camera.screenToWorld(originalScreen), equals: point)
    camera.pan(delta: GraphPoint(x: 23, y: -40))
    assertPoint(camera.worldToScreen(point), equals: GraphPoint(x: originalScreen.x + 23, y: originalScreen.y - 40))
  }

  func testPinchKeepsOffCenterAnchorFixed() {
    var camera = GraphCamera(center: GraphPoint(x: -9, y: 70), scale: 0.02, viewportWidth: 390, viewportHeight: 844)
    let anchor = GraphPoint(x: 51, y: 606)
    let world = camera.screenToWorld(anchor)
    for factor in [1.4, 0.25, 3.7, 0.9] {
      camera.zoom(factor: factor, anchor: anchor)
      assertPoint(camera.worldToScreen(world), equals: anchor)
    }
    let valid = camera
    camera.zoom(factor: 0, anchor: anchor)
    camera.zoom(factor: .infinity, anchor: anchor)
    XCTAssertEqual(camera, valid)
  }

  func testFitTinyForceAtlasExtentFillsViewport() {
    var camera = GraphCamera(viewportWidth: 390, viewportHeight: 844)
    let points = [GraphPoint(x: -0.00003, y: -0.00001), GraphPoint(x: 0.00003, y: 0.00001)]
    camera.fit(points: points, padding: 30)
    XCTAssertGreaterThan(camera.scale, 1_000_000)
    XCTAssertEqual(camera.worldToScreen(points[0]).x, 30, accuracy: 1e-9)
    XCTAssertEqual(camera.worldToScreen(points[1]).x, 360, accuracy: 1e-9)
    for point in points { XCTAssertTrue(camera.visibleWorldRect.contains(point)) }
  }

  func testFitEmptySingleAndVerticalLayouts() {
    var camera = GraphCamera(scale: 5, viewportWidth: 400, viewportHeight: 800)
    camera.fit(points: [])
    XCTAssertEqual(camera.scale, 5)
    camera.fit(points: [GraphPoint(x: 7, y: 9), GraphPoint(x: .nan, y: 2)])
    XCTAssertEqual(camera.center, GraphPoint(x: 7, y: 9))
    XCTAssertEqual(camera.scale, 5)
    camera.fit(points: [GraphPoint(x: 7, y: 0), GraphPoint(x: 7, y: 10)], padding: 50)
    XCTAssertEqual(camera.scale, 70)
    assertPoint(camera.worldToScreen(GraphPoint(x: 7, y: 0)), equals: GraphPoint(x: 200, y: 50))
  }

  func testSpatialQueryMatchesBruteForceIncludingCellBoundaries() {
    let nodes = fixtureNodes(count: 10_000)
    let index = GraphSpatialIndex(nodes: nodes, cellSize: 4)
    for rect in [
      GraphRect(x: 20, y: 32, width: 12, height: 17),
      GraphRect(x: -1e15, y: -1e15, width: 2e15, height: 2e15),
      GraphRect(x: -1, y: -1, width: 1, height: 1),
      GraphRect(x: 99, y: 99, width: 0, height: 0),
      GraphRect(x: 500, y: 500, width: 1, height: 1),
    ] {
      XCTAssertEqual(Set(index.query(rect).map(\.id)), Set(nodes.filter { rect.contains($0.point) }.map(\.id)))
    }
  }

  func testNearestAndNearbyUseCircleNotSquareAndStableTies() {
    let nodes = [
      GraphIndexedNode(id: "b", point: GraphPoint(x: 1, y: 0)),
      GraphIndexedNode(id: "a", point: GraphPoint(x: -1, y: 0)),
      GraphIndexedNode(id: "corner", point: GraphPoint(x: 1, y: 1)),
      GraphIndexedNode(id: "invalid", point: GraphPoint(x: .infinity, y: 0)),
    ]
    let index = GraphSpatialIndex(nodes: nodes, cellSize: 0.5)
    XCTAssertEqual(index.count, 3)
    XCTAssertEqual(index.nearest(to: .zero, radius: 1)?.id, "a")
    XCTAssertNil(index.nearest(to: .zero, radius: 0.9))
    XCTAssertEqual(index.nearby(to: .zero, radius: 1, limit: 10).map(\.id), ["a", "b"])
    XCTAssertEqual(index.nearby(to: .zero, radius: 1, limit: 10, excluding: "a").map(\.id), ["b"])
    XCTAssertEqual(index.nearby(to: .zero, radius: 10, limit: 1).map(\.id), ["a"])
    XCTAssertTrue(index.nearby(to: .zero, radius: 10, limit: 0).isEmpty)
    XCTAssertNil(GraphSpatialIndex(nodes: []).nearest(to: .zero, radius: 5))
  }

  func testSpatialIndexPreservesTinyLayoutCoordinates() {
    let nodes = [
      GraphIndexedNode(id: "left", point: GraphPoint(x: -1e-12, y: 0)),
      GraphIndexedNode(id: "right", point: GraphPoint(x: 1e-12, y: 0)),
    ]
    let index = GraphSpatialIndex(nodes: nodes)
    XCTAssertEqual(index.nearest(to: GraphPoint(x: 0.9e-12, y: 0), radius: 0.2e-12)?.id, "right")
    XCTAssertNil(index.nearest(to: .zero, radius: 0.5e-12))
  }

  func testSegmentHitTestingAndViewportCrossings() {
    let start = GraphPoint(x: -10, y: 5)
    let end = GraphPoint(x: 20, y: 5)
    let rect = GraphRect(x: 0, y: 0, width: 10, height: 10)
    XCTAssertTrue(GraphGeometry.segmentIntersectsRect(start: start, end: end, rect: rect))
    XCTAssertTrue(GraphGeometry.segmentIntersectsRect(start: GraphPoint(x: -1, y: -1), end: .zero, rect: rect))
    XCTAssertFalse(GraphGeometry.segmentIntersectsRect(start: GraphPoint(x: -10, y: 11), end: GraphPoint(x: 20, y: 11), rect: rect))
    XCTAssertTrue(GraphGeometry.hitTestSegment(GraphPoint(x: 5, y: 8), start: start, end: end, radius: 3))
    XCTAssertFalse(GraphGeometry.hitTestSegment(GraphPoint(x: 5, y: 8.1), start: start, end: end, radius: 3))
    XCTAssertEqual(GraphGeometry.distanceToSegment(GraphPoint(x: 23, y: 9), start: start, end: end), 5, accuracy: 1e-9)
    XCTAssertEqual(GraphGeometry.distanceToSegment(GraphPoint(x: 3, y: 4), start: .zero, end: .zero), 5)
  }

  func testTenThousandNodeThirtyThousandEdgeFixture() {
    let nodes = fixtureNodes(count: 10_000)
    let index = GraphSpatialIndex(nodes: nodes)
    let edges = (0..<30_000).map { (nodes[$0 % nodes.count].point, nodes[($0 * 17 + 151) % nodes.count].point) }
    let viewport = GraphRect(x: 30, y: 30, width: 40, height: 40)
    // Exercise actual culling and hit-test workloads in release mode, including crossing edges.
    // The count assertions keep optimized builds from discarding the measured work.
    measure {
      XCTAssertEqual(index.query(viewport).count, 1_681)
      var hits = 0
      for i in 0..<1_000 {
        if index.nearest(to: GraphPoint(x: Double(i % 100) + 0.1, y: Double(i / 100) + 0.1), radius: 0.3) != nil { hits += 1 }
      }
      XCTAssertEqual(hits, 1_000)
      let visible = edges.filter { GraphGeometry.segmentIntersectsRect(start: $0.0, end: $0.1, rect: viewport) }
      XCTAssertGreaterThan(visible.count, 5_000)
      XCTAssertLessThan(visible.count, edges.count)
    }
  }

  private func fixtureNodes(count: Int) -> [GraphIndexedNode] {
    (0..<count).map { GraphIndexedNode(id: String($0), point: GraphPoint(x: Double($0 % 100), y: Double($0 / 100))) }
  }

  private func assertPoint(_ actual: GraphPoint, equals expected: GraphPoint, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(actual.x, expected.x, accuracy: 1e-8, file: file, line: line)
    XCTAssertEqual(actual.y, expected.y, accuracy: 1e-8, file: file, line: line)
  }
}
