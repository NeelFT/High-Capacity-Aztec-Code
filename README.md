# High-Capacity Aztec Code

A small experiment in moving a file from one screen to another with light. The app turns a file into a repeating stream of color-coded, Aztec-style frames. A second device watches that stream with its camera, rebuilds the file from the packets it can read, and downloads it when the transfer is complete.

This is a custom visual-transfer format, not a standard Aztec barcode reader. It does not send the file over Wi-Fi or through a server; the data travels in the changing colors on the sender's screen.

The sender and receiver must use the same matrix size. Transfers are limited to 16 MiB and may be further limited by the selected matrix's packet capacity and the protocol's block-count limit. Every packet is checked with CRC32, and the receiver only downloads the reconstructed file after its SHA-256 digest matches the sender's metadata.
File names and MIME types are limited to 120 UTF-8 bytes each; files with longer metadata are rejected rather than renamed or relabeled during transfer.

## Try it locally

You need Node.js 20.19 or newer.

```sh
npm ci
npm run dev
```

Open the **Network** HTTPS address printed by Vite on each device (for example, `https://192.168.1.20:5173/`), not `localhost` on the phone. The server binds to all network interfaces on the fixed port 5173; Vite exits with a clear error if that port is already in use rather than silently switching to a port that may not be allowed through the firewall. The development certificate includes the computer's current LAN addresses. It is not issued by a public certificate authority, so each device must trust or proceed past the development-certificate warning before the browser will load the page. Camera access requires HTTPS (or `localhost`).

## Send a file

1. On the sending device, open the app and choose a file.
2. Pick a matrix size. The available transfer sizes are 32 x 32 and 63 x 63; use the same size on both devices. A larger matrix carries more data per frame but needs a larger, sharper image from the camera.
3. Press **Send**. The color frame will keep cycling until you stop it.
4. On the receiving device, open the same app, choose **Receive**, and press **Start camera**.
5. Point the camera at the sender's screen and keep the full frame in view. When enough packets have been decoded, the reconstructed file downloads automatically.

The sender includes the original blocks plus repair packets, then repeats the sequence. That gives the receiver another chance to collect missing data if a frame is blurred or missed. A steady, bright screen, a focused camera, and low glare help. Keep the whole frame visible and large in the camera preview; use the camera zoom control if the browser/device offers it. Camera permission requires HTTPS (or localhost), and some mobile browsers restrict camera access when the page is opened from an insecure LAN address.

The visual layout uses a centered, one-module alternating-ring bullseye: 8 x 8 modules for the even 32 x 32 matrix and 9 x 9 for the odd 63 x 63 matrix. The one-module parity difference keeps both finders exactly centered on the module grid. Alignment tracks are outside the finder, and the renderer and decoder share the same matrix geometry and two-module white quiet zone.

Every frame spreads the eight palette colors across its data modules, excluding the bullseye and structural guides. The sender applies a reversible packet-seeded color mask after the fixed header and balances unused padding modules; packet bytes, CRC, and capacity are unchanged. The receiver accepts both the current seeded mapping and earlier frames that used the fixed color mask.

## Diagnose and test the receiver

The Receive panel reports camera frames, candidate regions, geometry/orientation, sampled colors, header/CRC results, accepted packets, recovered blocks, and final SHA-256 verification. Its preview overlays candidate corners and the estimated grid; the latest decoder error is shown separately.

Use **Run decoder self-test** to generate and render a real packet, then pass its pixels through the production decoder worker and reconstruction path without a second device. To test a camera photo or screenshot, choose **Decode saved frame** and ensure the selected matrix size matches the image. Neither synthetic test proves camera-to-camera transfer; that still requires testing with two devices.

## Build

```sh
npm run build
npm run preview
```

The production files are written to `dist/`.