# Desktop 发布资产

`desktop.ico` 由 Renderer 的 `src/renderer/public/product-mark.svg` 原创品牌图形生成，供 Electron Packager 与 Squirrel Setup 使用。发布资产使用 Sharp 渲染 SVG，并由 FFmpeg ICO muxer 合成 16、24、32、48、64、128、256 像素图层；应用代码不维护手写二进制编码器。
