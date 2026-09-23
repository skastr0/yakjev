import ExpoModulesCore

struct YakjevNodeRecord: Record {
  @Field var id: String = ""
  @Field var label: String = ""
  @Field var x: Double = 0
  @Field var y: Double = 0
  @Field var color: String = "#2c84ff"
}

struct YakjevEdgeRecord: Record {
  @Field var id: String = ""
  @Field var source: String = ""
  @Field var target: String = ""
  @Field var color: String = "#668477"
  @Field var label: String = ""
}

public final class YakjevGraphModule: Module {
  public func definition() -> ModuleDefinition {
    Name("YakjevGraph")

    View(YakjevGraphView.self) {
      Events("onNodePress", "onEdgePress", "onCanvasPress", "onNodeDrag", "onConnect", "onRendererError")
      Prop("nodes") { (view: YakjevGraphView, value: [YakjevNodeRecord]) in view.setNodes(value) }
      Prop("edges") { (view: YakjevGraphView, value: [YakjevEdgeRecord]) in view.setEdges(value) }
      Prop("ghostEdges") { (view: YakjevGraphView, value: [YakjevEdgeRecord]) in view.setGhostEdges(value) }
      Prop("selectedNodeId") { (view: YakjevGraphView, value: String) in view.selectedNodeId = value }
      Prop("selectedEdgeId") { (view: YakjevGraphView, value: String) in view.selectedEdgeId = value }
      Prop("connectSourceId") { (view: YakjevGraphView, value: String) in view.connectSourceId = value }
      Prop("focusNodeId") { (view: YakjevGraphView, value: String) in view.focusNodeId = value }
      Prop("fitRequest") { (view: YakjevGraphView, value: Int) in view.fitRequest = value }
      Prop("interactive") { (view: YakjevGraphView, value: Bool) in view.interactive = value }
      OnViewDidUpdateProps { view in view.applyProps() }
    }
  }
}
