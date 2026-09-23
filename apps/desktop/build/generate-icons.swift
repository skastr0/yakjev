// Run on macOS: swift apps/desktop/build/generate-icons.swift
// Uses AppKit and iconutil only. The SVG is the source for every platform icon.
import AppKit
import Foundation

let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let source = directory.appendingPathComponent("icon.svg")
guard let image = NSImage(contentsOf: source) else {
    fatalError("Cannot read \(source.path)")
}

func png(size: Int, opaque: Bool = false) throws -> Data {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Cannot create icon bitmap")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    if opaque {
        NSColor(srgbRed: 245.0 / 255, green: 242.0 / 255, blue: 233.0 / 255, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: size, height: size).fill()
    }
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    var output = bitmap
    if opaque {
        // AppKit renders into RGBA; encode a separate RGB bitmap with no alpha channel.
        guard let rgb = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
            bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false,
            isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: size * 3, bitsPerPixel: 24
        ), let sourcePixels = bitmap.bitmapData, let targetPixels = rgb.bitmapData else {
            fatalError("Cannot create opaque icon bitmap")
        }
        for y in 0..<size {
            for x in 0..<size {
                let sourceOffset = y * bitmap.bytesPerRow + x * 4
                let targetOffset = y * rgb.bytesPerRow + x * 3
                for channel in 0..<3 {
                    targetPixels[targetOffset + channel] = sourcePixels[sourceOffset + channel]
                }
            }
        }
        output = rgb
    }
    guard let data = output.representation(using: .png, properties: [:]) else {
        fatalError("Cannot encode icon PNG")
    }
    return data
}

try png(size: 1024).write(to: directory.appendingPathComponent("icon.png"))
try png(size: 1024, opaque: true).write(to: directory.appendingPathComponent("icon-mobile.png"))

let iconset = FileManager.default.temporaryDirectory
    .appendingPathComponent("yakjev-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }
for size in [16, 32, 128, 256, 512] {
    try png(size: size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try png(size: size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["--convert", "icns", "--output", directory.appendingPathComponent("icon.icns").path, iconset.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }

// Windows accepts PNG-compressed images inside an ICO container.
let windowsPng = try png(size: 256)
var ico = Data()
func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { ico.append(contentsOf: $0) }
}
appendLittleEndian(UInt16(0)) // Reserved
appendLittleEndian(UInt16(1)) // Icon
appendLittleEndian(UInt16(1)) // One image
ico.append(contentsOf: [0, 0, 0, 0]) // 256 × 256, full color
appendLittleEndian(UInt16(1)) // Color planes
appendLittleEndian(UInt16(32)) // Bits per pixel
appendLittleEndian(UInt32(windowsPng.count))
appendLittleEndian(UInt32(22)) // Header and directory entry length
ico.append(windowsPng)
try ico.write(to: directory.appendingPathComponent("icon.ico"))
print("Generated icon.png, icon-mobile.png, icon.icns and icon.ico from icon.svg")
