# Lamplight

**Measures whether a camera can actually read you, and tells you what to change when the room is the problem.**

Built for the DEV Presage SmartSpectra SDK Challenge with `@smartspectra/node-sdk` 3.5.0.

---

## The problem

Every camera-vitals demo is filmed in a good room.

Presage publishes what happens outside one. From their own arterial-pressure model card, by lighting condition for Fitzpatrick Type VI:

| Lighting | N | Return rate |
|---|---|---|
| Ring light | 526 | **53.2%** |
| Lamp | 427 | **40.4%** |
| Window | 327 | **34.2%** |

Same faces, same models, same cameras. The only variable is the room. Two out of three readings are lost to lighting that the person cannot see is a problem — because human eyes adapt across an enormous range and a webcam sensor does not.

**Lamplight names the physical cause and refuses to invent a number.**

---

## What it does

1. Runs the measurement on the webcam through the SmartSpectra SDK
2. Shows the **cause** when the room blocks the reading — not a spinner
3. Gives **one physical instruction** to fix it
4. Shows pulse and breathing only once a real window has filled
5. Writes a **local receipt** stating exactly what was and was not measured

### The one rule

> **The app describes light, position, and stability. It never describes the person.**

Good: *"The light is behind you. Turn it around, or move so it lights your face."*
Never: *"Your face is hard to read."*

Nothing here asks for, infers, or displays skin tone. It measures the signal, not the person.

---

## The demo

The honest ending is the point.

```
Start in a dim room          → 0 of 2 metrics
  "Not enough light"
    → turn on a lamp
  camera sees you            → "Clear"
  pulse warms up             → 12s
  breathing warms up         → 30s
                              → 2 of 2 metrics
  receipt written, local, dated
```

It also has to work the other way. If a metric never arrives, the receipt says **`not measured`**, in red, and the app says so plainly. It never estimates, infers, or fills in a number it did not receive.

---

## Run it

```bash
npm install
```

```bash
set PHYSIOLOGY_API_KEY=your_key_here
```

```bash
npm start
```

Then open **http://localhost:4173**

Press **Start measuring**, sit back so your upper body is in frame, and hold still.

Requires Node 20 or newer and a webcam. The key comes from
[physiology.presagetech.com](https://physiology.presagetech.com/auth/login).

---

## How it is built

One Node process and one page.

```
server.js          owns the camera through the SDK, holds session state,
                   streams it to the page over Server-Sent Events
public/index.html  the whole UI — no framework, no build step
receipts/          local JSON, one file per session
```

**Why not Electron.** The SDK's camera path runs in a Node process. A browser page cannot open a webcam from a server, so the SDK owns the device and the page is only a display. This removes the Electron main/preload/renderer IPC surface entirely and everything needed to make it work is already proven on the target machine.

### Metrics, by code

Requested by `MetricType` code, never by bundle — `cardioMetrics` pulls in arterial pressure and HRV and can trip `METRIC_NOT_AUTHORIZED`:

```
CHEST_BREATHING 1 · BREATHING_RATE 2 · PULSE_RATE 15
```

### Never show a number before its window fills

| Metric | Window |
|---|---|
| Pulse | 12s |
| Breathing | 30s |

The warm-up clock only runs while the camera can actually see you. If the cause is `no_face`, `too_dark`, or `chest_not_visible`, the clock is held — time spent invisible does not count as warming up.

### Validation codes drive the coaching

The SDK reports a per-frame validation code. Lamplight maps each to one physical action:

`no_face` · `multiple_faces` · `off_centre` · `too_dark` · `too_bright` · `chest_not_visible` · `camera_tuning` · `frame_rate_low` · `too_much_motion` · `face_too_close` · `face_too_far` · `face_too_high` · `face_too_low` · `face_not_forward`

---

## What we measured before building

Every claim here was tested on real hardware with `@smartspectra/node-sdk` 3.5.0 on Windows, not assumed from documentation.

| Room | Validation | Packets | Reading |
|---|---|---|---|
| Total dark | `no_face` | 0 | **none** |
| Dim | `no_face` → `TOO_DARK` | 0 | **none** |
| Backlit by a window | `ok` | 450 | **82 bpm, 16/min** |
| Lit | `ok` | 428 / 20s | **14.4 /min** |

**What this showed.** Total darkness kills the reading entirely. But a *backlit* room — window behind the subject, face in shadow — still read fine, because the camera's auto-exposure compensated. On this hardware the failure is a cliff, not a gradient: below the sensor's floor there is nothing to coach, and above it the reading arrives.

**Two findings that changed the design:**

1. **The failure is binary on this camera.** There is no gentle slope of degrading confidence to walk a user up. So Lamplight does not pretend to chart one. It reports the cause and states plainly whether a reading exists — one honest round, not a fabricated multi-round gradient.

2. **Exposure lock collapses the image on this hardware.** The SDK attempts to lock exposure; on this camera it drives luma from 68 to 6.7 and the driver then reverts to auto, with no AE lock and no gain control available:

   ```
   [exposure-topup] lock collapsed image brightness (luma=6.67472 vs pre-lock 68.3133)
   and manual levers are exhausted — exposure reverted to AUTO.
   ```

   Repeatable across five runs. This is a genuine hardware limitation, and it means a room that looks fine can still read as dark.

We deliberately did **not** ship the "walk the user up a lighting gradient" version the original pitch assumed, because the measurements did not support it. Building that would have meant inventing a gradient that does not exist on the hardware.

---

## What it is not

- **Not a medical device.** No diagnosis, no treatment, no clinical claim. It reports what a sensor measured, with the sensor's own confidence values attached.
- **Not a skin-tone estimator.** Never asks for, infers, or displays Fitzpatrick type.
- **Not a readiness checker.** `checkDeviceReadiness()` is a pre-flight check and already table stakes. Lamplight is about what happens during a measurement, once a reading is at stake.
- **No uploads.** The receipt is written to `receipts/` on the local machine. The only network traffic is the key check the SDK performs with Presage.

---

## Privacy

The measurement runs on the device. Lamplight writes one JSON file per session to `receipts/` and nothing else. Telemetry is disabled at session construction (`enableTelemetry: false`).

---

## Licence and attribution

The camera capture path is the official `@smartspectra/node-sdk` package. No native bridge code is vendored into this repository.

Model-card figures quoted above are from Presage's published documentation and are reproduced here as the reason the app exists, not as a claim about this implementation.
