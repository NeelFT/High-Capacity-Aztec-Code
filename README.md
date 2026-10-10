# High-Capacity Aztec Code

A small experiment in moving a file from one screen to another with light. The app turns a file into a repeating stream of color-coded, Aztec-style frames. A second device watches that stream with its camera, rebuilds the file from the packets it can read, and downloads it when the transfer is complete.

This is a custom visual-transfer format, not a standard Aztec barcode reader. It does not send the file over Wi-Fi or through a server; the data travels in the changing colors on the sender's screen.

## Try it locally

You need Node.js 20.19 or newer.

```sh
npm ci
npm run dev
```

Open the local HTTPS address printed by Vite. The receiver uses the browser camera, which requires a secure page (HTTPS, or `localhost`). Accept the local development certificate warning if your browser shows one.

## Send a file

1. On the sending device, open the app and choose a file.
2. Pick a matrix size. The current choices are 63 x 63 and 95 x 95; use the same size on both devices.
3. Press **Send**. The color frame will keep cycling until you stop it.
4. On the receiving device, open the same app, choose **Receive**, and press **Start camera**.
5. Point the camera at the sender's screen and keep the full frame in view. When enough packets have been decoded, the reconstructed file downloads automatically.

The sender includes the original blocks plus a small set of repair packets, then repeats the sequence. That gives the receiver another chance to collect missing data if a frame is blurred or missed. A steady, bright screen, a focused camera, and low glare help; larger matrix sizes carry more data per frame but need a clearer view.

## Build

```sh
npm run build
npm run preview
```

The production files are written to `dist/`.