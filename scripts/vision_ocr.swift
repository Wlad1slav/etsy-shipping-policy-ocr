#!/usr/bin/env swift

import Foundation
import ImageIO
import Vision

struct OCRLine: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRImage: Codable {
    let path: String
    let pixelWidth: Int
    let pixelHeight: Int
    let lines: [OCRLine]
}

enum OCRError: Error, CustomStringConvertible {
    case usage
    case unreadableImage(String)
    case invalidCrop(String)

    var description: String {
        switch self {
        case .usage:
            return "Usage: vision_ocr.swift <image> [<image> ...]"
        case .unreadableImage(let path):
            return "Could not read image: \(path)"
        case .invalidCrop(let path):
            return "Could not crop image: \(path)"
        }
    }
}

func recognize(_ path: String) throws -> OCRImage {
    let url = URL(fileURLWithPath: path)
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw OCRError.unreadableImage(path)
    }

    let imageWidth = image.width
    let imageHeight = image.height
    let cropX = Int((Double(imageWidth) * 0.10).rounded(.down))
    let cropWidth = imageWidth - (cropX * 2)
    let tileHeight = 3000
    let overlap = 240
    let step = tileHeight - overlap
    var allLines: [OCRLine] = []

    var tileTop = 0
    while tileTop < imageHeight {
        let currentHeight = min(tileHeight, imageHeight - tileTop)
        let cropRect = CGRect(x: cropX, y: tileTop, width: cropWidth, height: currentHeight)
        guard let tile = image.cropping(to: cropRect) else {
            throw OCRError.invalidCrop(path)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0.006

        let handler = VNImageRequestHandler(cgImage: tile, orientation: .up, options: [:])
        try handler.perform([request])

        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let box = observation.boundingBox
            let line = OCRLine(
                text: candidate.string,
                confidence: candidate.confidence,
                x: Double(cropX) + box.origin.x * Double(cropWidth),
                y: Double(tileTop) + (1.0 - box.origin.y - box.height) * Double(currentHeight),
                width: box.width * Double(cropWidth),
                height: box.height * Double(currentHeight)
            )
            allLines.append(line)
        }

        if tileTop + currentHeight >= imageHeight { break }
        tileTop += step
    }

    // Overlapping tiles can produce the same line twice. Keep the strongest copy.
    var unique: [OCRLine] = []
    for line in allLines.sorted(by: { lhs, rhs in
        if abs(lhs.y - rhs.y) > 1 { return lhs.y < rhs.y }
        return lhs.x < rhs.x
    }) {
        if let duplicateIndex = unique.firstIndex(where: {
            $0.text.caseInsensitiveCompare(line.text) == .orderedSame &&
            abs($0.x - line.x) < 35 && abs($0.y - line.y) < 35
        }) {
            if line.confidence > unique[duplicateIndex].confidence {
                unique[duplicateIndex] = line
            }
        } else {
            unique.append(line)
        }
    }

    return OCRImage(
        path: path,
        pixelWidth: imageWidth,
        pixelHeight: imageHeight,
        lines: unique.sorted(by: { lhs, rhs in
            if abs(lhs.y - rhs.y) > 1 { return lhs.y < rhs.y }
            return lhs.x < rhs.x
        })
    )
}

do {
    let paths = Array(CommandLine.arguments.dropFirst())
    guard !paths.isEmpty else { throw OCRError.usage }
    let results = try paths.map(recognize)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(results)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("OCR error: \(error)\n".utf8))
    exit(1)
}
