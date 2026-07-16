// Renders the Tethr app-icon master PNG (1024×1024) with CoreGraphics — no
// external tools. On-brand: a black squircle tile with a white wireframe mark
// (a square + a top divider line + the brand dot), matching the web favicon.
//
//   swiftc make-icon.swift -o make-icon && ./make-icon out.png
//
// build-app.sh then fans this out to an .iconset via `sips` + `iconutil`.

import AppKit

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon_1024.png"
let size = 1024
let W = CGFloat(size)

let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    FileHandle.standardError.write(Data("icon: could not create context\n".utf8))
    exit(1)
}

let black = CGColor(red: 10 / 255, green: 10 / 255, blue: 10 / 255, alpha: 1)
let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)

ctx.clear(CGRect(x: 0, y: 0, width: W, height: W))

// Squircle tile (macOS icon-grid corner radius ≈ 0.2237 of the edge).
let tile = CGRect(x: 0, y: 0, width: W, height: W).insetBy(dx: W * 0.06, dy: W * 0.06)
let r = tile.width * 0.2237
ctx.addPath(CGPath(roundedRect: tile, cornerWidth: r, cornerHeight: r, transform: nil))
ctx.setFillColor(black)
ctx.fillPath()

// White wireframe square (the mark).
let m = W * 0.34
let mrect = CGRect(x: (W - m) / 2, y: (W - m) / 2, width: m, height: m)
ctx.setStrokeColor(white)
ctx.setLineWidth(W * 0.026)
ctx.setLineJoin(.miter)
ctx.stroke(mrect)

// Horizontal divider across the upper third of the square.
let ly = mrect.maxY - m * 0.30
ctx.move(to: CGPoint(x: mrect.minX, y: ly))
ctx.addLine(to: CGPoint(x: mrect.maxX, y: ly))
ctx.strokePath()

// Brand dot sitting on the divider (left of center).
let dot = W * 0.024
ctx.setFillColor(white)
ctx.fillEllipse(in: CGRect(x: mrect.minX + m * 0.20 - dot, y: ly - dot, width: dot * 2, height: dot * 2))

guard let img = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: img)
guard let data = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! data.write(to: URL(fileURLWithPath: outPath))
