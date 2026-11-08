// Renders the tethr icon master PNG (1024×1024) with CoreGraphics and CoreImage,
// no external tools. The mark is the chat's "working" nebula: two soft spiral
// arms around a bright core, with three motes on faint tilted orbits, in warm
// bone on the brand's Night ink. Monochrome, like the brand.
//
//   swiftc make-icon.swift -o make-icon && ./make-icon out.png [tile|square]
//
// tile (default): a macOS squircle with transparent corners, for the desktop
// apps (scripts/tethr-launcher/build.sh fans it out with sips + iconutil).
// square: full bleed, for phone home screens that round the corners themselves
// (scripts/tethr-icon/favicons.sh).

import AppKit
import CoreImage

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon_1024.png"
let fullBleed = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "square"
let size = 1024
let W = CGFloat(size)
let cs = CGColorSpaceCreateDeviceRGB()

func makeContext() -> CGContext {
    guard let ctx = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        FileHandle.standardError.write(Data("icon: could not create context\n".utf8))
        exit(1)
    }
    return ctx
}

let ink = CGColor(red: 11 / 255, green: 10 / 255, blue: 9 / 255, alpha: 1)     // Night ground #0B0A09
func bone(_ a: CGFloat) -> CGColor { CGColor(red: 233 / 255, green: 231 / 255, blue: 227 / 255, alpha: a) } // #E9E7E3
let center = CGPoint(x: W / 2, y: W / 2)

/// A soft round glow: `color` at the middle fading to nothing at `radius`.
func glow(_ ctx: CGContext, at p: CGPoint, radius: CGFloat, alpha: CGFloat, hot: CGFloat = 0) {
    let colors = [bone(alpha), bone(alpha * 0.35), bone(0)] as CFArray
    let stops: [CGFloat] = [hot, 0.45, 1]
    guard let g = CGGradient(colorsSpace: cs, colors: colors, locations: stops) else { return }
    ctx.drawRadialGradient(g, startCenter: p, startRadius: 0, endCenter: p, endRadius: radius, options: [])
}

// ---- The nebula, drawn on its own layer so it can be blurred ----------------
let cloud = makeContext()
cloud.clear(CGRect(x: 0, y: 0, width: W, height: W))
cloud.setBlendMode(.screen)

// Two spiral arms: soft puffs along log-like spirals, fading and widening outward.
for arm in 0..<2 {
    let start = CGFloat(arm) * .pi + 0.35
    let steps = 46
    for i in 0..<steps {
        let t = CGFloat(i) / CGFloat(steps - 1)
        let angle = start + t * 2.6
        let r = W * (0.035 + 0.25 * pow(t, 0.92))
        let p = CGPoint(x: center.x + cos(angle) * r, y: center.y + sin(angle) * r * 0.9)
        let puff = W * (0.045 + 0.075 * t)
        let alpha = (arm == 0 ? 0.26 : 0.2) * (1 - pow(t, 1.35))
        glow(cloud, at: p, radius: puff, alpha: alpha)
    }
}
// A faint haze that ties the arms together.
glow(cloud, at: center, radius: W * 0.33, alpha: 0.16)

guard let cloudImage = cloud.makeImage() else { exit(1) }
let ci = CIImage(cgImage: cloudImage)
let blurred = ci.clampedToExtent().applyingGaussianBlur(sigma: Double(W * 0.012)).cropped(to: ci.extent)
let ciContext = CIContext(options: [.workingColorSpace: cs])
guard let softCloud = ciContext.createCGImage(blurred, from: ci.extent) else { exit(1) }

// ---- The tile ---------------------------------------------------------------
let ctx = makeContext()
ctx.clear(CGRect(x: 0, y: 0, width: W, height: W))

// Squircle tile (macOS icon-grid corner radius ≈ 0.2237 of the edge), or the
// whole square for phone icons.
let tile = fullBleed ? CGRect(x: 0, y: 0, width: W, height: W) : CGRect(x: 0, y: 0, width: W, height: W).insetBy(dx: W * 0.06, dy: W * 0.06)
let r = fullBleed ? 0 : tile.width * 0.2237
let tilePath = CGPath(roundedRect: tile, cornerWidth: r, cornerHeight: r, transform: nil)
ctx.addPath(tilePath)
ctx.setFillColor(ink)
ctx.fillPath()

ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()

// A soft overhead light on the ground, like the app's own background.
glow(ctx, at: CGPoint(x: W / 2, y: W * 0.98), radius: W * 0.75, alpha: 0.05)

ctx.setBlendMode(.screen)
ctx.draw(softCloud, in: CGRect(x: 0, y: 0, width: W, height: W))

// Faint orbits, tilted and flattened, with a mote riding each.
struct Orbit { let rx: CGFloat; let squash: CGFloat; let tilt: CGFloat; let mote: CGFloat; let size: CGFloat; let alpha: CGFloat }
let orbits = [
    Orbit(rx: W * 0.30, squash: 0.44, tilt: 0.42, mote: 2.35, size: W * 0.016, alpha: 0.9),
    Orbit(rx: W * 0.21, squash: 0.6, tilt: -0.66, mote: 5.4, size: W * 0.013, alpha: 0.85),
    Orbit(rx: W * 0.355, squash: 0.36, tilt: -1.2, mote: 0.6, size: W * 0.011, alpha: 0.6),
]
for o in orbits {
    ctx.saveGState()
    ctx.translateBy(x: center.x, y: center.y)
    ctx.rotate(by: o.tilt)
    ctx.setStrokeColor(bone(0.1))
    ctx.setLineWidth(W * 0.0028)
    ctx.strokeEllipse(in: CGRect(x: -o.rx, y: -o.rx * o.squash, width: o.rx * 2, height: o.rx * 2 * o.squash))
    let mote = CGPoint(x: cos(o.mote) * o.rx, y: sin(o.mote) * o.rx * o.squash)
    glow(ctx, at: mote, radius: o.size * 4, alpha: o.alpha * 0.45)
    ctx.setFillColor(bone(o.alpha))
    ctx.fillEllipse(in: CGRect(x: mote.x - o.size, y: mote.y - o.size, width: o.size * 2, height: o.size * 2))
    ctx.restoreGState()
}

// The core: a bright point inside a warm glow.
glow(ctx, at: center, radius: W * 0.15, alpha: 0.55, hot: 0.05)
glow(ctx, at: center, radius: W * 0.055, alpha: 1, hot: 0.25)
ctx.restoreGState()

guard let img = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: img)
guard let data = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! data.write(to: URL(fileURLWithPath: outPath))
