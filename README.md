# Kitbench

Photo → kitting tray. Lay tools on a sheet of Letter or A4 paper, take a photo, and get a chamfered tray with fitted pockets and finger scoops, exported as 3MF or STL.

Live: https://bleeb246-lgtm.github.io/kitbench/

## What it does
- Finds the sheet, corrects perspective, and tells Letter from A4 from the sheet's true aspect.
- Traces each tool; erase/add brush for shadows and missed parts.
- Parallax correction from estimated camera height and per-tool silhouette height.
- Tray W/D/H with a fixed floor, global and per-tool clearance, chamfers on the outer edges, pocket lip and pocket floor.
- Finger scoops (round-bottom, rounded ends), on-canvas move/resize/rotate.
- Auto-arrange (squares tools up, packs to the smallest tray), undo/redo, full screen.
- 3MF and STL export; everything runs in the browser, nothing is uploaded.

## Photo tips
- Even, diffuse light (shade or overcast). Hard light means erasing shadows.
- 2× zoom from further back cuts parallax; set the lens field to the 35 mm equivalent (Pixel 2× ≈ 50 mm) if the photo has no metadata.
- Silhouette height ≈ half the tool's thickness lying on its side.

## Credits
Geometry by [Manifold](https://github.com/elalish/manifold) (Apache-2.0), embedded. 3D preview by three.js (MIT), loaded from CDN.

## Building
`index.html` is self-contained and is what GitHub Pages serves. To rebuild it after editing `src/`:

```
npm i manifold-3d@3.4.1
python3 build.py
```
