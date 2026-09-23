import UIKit

struct GraphCanvasLabel {
  var text: String
  var center: CGPoint
  var size: CGSize
  var angle: CGFloat = 0
  var font: UIFont
  var color: UIColor

  var bounds: CGRect {
    let width = abs(cos(angle)) * size.width + abs(sin(angle)) * size.height
    let height = abs(sin(angle)) * size.width + abs(cos(angle)) * size.height
    return CGRect(x: center.x - width / 2 - 3, y: center.y - height / 2 - 2, width: width + 6, height: height + 4)
  }
}

/// A single CoreGraphics overlay, bounded to a small visible-label budget.
final class GraphLabelOverlay: UIView {
  static let paper = UIColor(red: 245.0 / 255, green: 242.0 / 255, blue: 233.0 / 255, alpha: 1)
  var labels: [GraphCanvasLabel] = []
  var connection: (CGPoint, CGPoint)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    isUserInteractionEnabled = false
    backgroundColor = .clear
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    if let (start, end) = connection {
      context.setStrokeColor(UIColor(red: 111.0 / 255, green: 82.0 / 255, blue: 237.0 / 255, alpha: 0.8).cgColor)
      context.setLineWidth(1)
      context.setLineDash(phase: 0, lengths: [4, 4])
      context.move(to: start)
      context.addLine(to: end)
      context.strokePath()
      context.setLineDash(phase: 0, lengths: [])
    }
    for label in labels {
      context.saveGState()
      context.translateBy(x: label.center.x, y: label.center.y)
      context.rotate(by: label.angle)
      let textRect = CGRect(x: -label.size.width / 2, y: -label.size.height / 2, width: label.size.width, height: label.size.height)
      context.setFillColor(Self.paper.cgColor)
      context.fill(textRect.insetBy(dx: -3, dy: -1))
      let paragraph = NSMutableParagraphStyle()
      paragraph.lineBreakMode = .byTruncatingTail
      (label.text as NSString).draw(in: textRect, withAttributes: [
        .font: label.font, .foregroundColor: label.color, .paragraphStyle: paragraph,
      ])
      context.restoreGState()
    }
  }
}

final class GraphNodeAccessibilityElement: UIAccessibilityElement {
  var activate: (() -> Void)?
  override func accessibilityActivate() -> Bool { activate?(); return activate != nil }
}
