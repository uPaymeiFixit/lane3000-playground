# lane3000-playground

Driving a retired Ingenico Lane/3000 payment terminal from a Mac over USB, using only the
terminal's stock RBA (Retail Base Application) firmware. No firmware changes, no signing keys:
the Mac sends the same host commands a point-of-sale system would.

## Files

| File | What it does |
|---|---|
| `lane.py` | Driver for the RBA serial protocol (standard library only) |
| `game_screen.py` | Installs `GAME.K3Z`, a full-screen image layout with every key enabled; frame/key helper |
| `snake.py` | Real-time full-screen Snake (~4.5 frames/s) |
| `maze.py` | Random full-screen maze, a new one every game (~0.25 s per move) |
| `maze_script.py` | Maze as a generated RBA script — does NOT run on this unit (no `26.x` support) |
| `coin_grab.py` | Early text-grid experiment (superseded: ASCII looks bad on this screen) |
| `skimmer_hunt.py` | Early ASCII 3D experiment (superseded: too small to read) |
| `light_test.py` | Four-tone beep jingle and a slow, captioned light test |
| `card_test.py` | Card reader test with beep feedback (`card_test.py 120 M` = swipe only) |
| `lock_probe.py` | Experiments that found `15.6` clears the post-card-read upload lock |
| `io_demo.py` | Beeps, lights, audio and card-reader experiments (see its docstring for results) |
| `show_image.py` | Full-screen images on the terminal, plus a frame-rate test |
| `backups/AD13.JPG` | Original ad image that `show_image.py` overwrites; restore with `--restore` |

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python game_screen.py --install    # once: uploads GAME.K3Z + images, reboots the terminal
.venv/bin/python snake.py
.venv/bin/python maze.py
.venv/bin/python game_screen.py --uninstall  # removes those files, reboots
.venv/bin/python show_image.py --restore     # puts the original AD13.JPG ad back
```

## What we learned about this terminal

### Protocol and screens


- Shows up as USB CDC serial (`/dev/cu.usbmodem*`), USB vendor `0x0B00`, product "Lane3000".
- Framing: `STX` + body + `ETX` + LRC (XOR of everything after STX, including ETX). The
  terminal ACKs (`0x06`) each frame, then sends its reply as its own frame, which the host ACKs.
- `07.` returns unit data (`INGNAR`, `L3000`, ...).
- `65.<type><fmt><path>` reads files (format `1` = base64, works for images).
  `manifest.txt` / `manifestfrm.txt` list all files / all forms.
- Screens are `.K3Z` XML forms, 320x240. `24.<form>` shows one; `[FS]T<id>,<text>` overrides a
  label; `[FS]B<id>,S` shows a hidden button. The reply `24.0<key>` says which key closed it.
- Keys only reach the host when the form enables them. F-keys only report when the form links
  them to a button. Digits and yellow never reported on any stock form we tried; variable 805
  (raw key events) is rejected on this model.
- `BAMTV.K3Z`: 8 x 38 monospace line display (the last column is hidden in practice, so use
  36), title label `PROMPTLINE1`, F1-F4 report `C P Y N`, green `\r`, red `\x1b`.
- Line display rows are variables 111-118: `28.90000111<text>` (`9` = no reply).
- `62.x` file write: 8-bit encoding (bytes `00-1F` -> `FF, b+20`; `FF` -> `FF FF`), blocks up to
  ~3.8 KB work over USB. Images (JPG/PNG/GIF/BMP) apply without a reboot; `.K3Z` files need one.
- `AD1.K3Z`..`AD13.K3Z` each show one full-screen `AD<n>.JPG`. Uploading a 16 KB JPEG takes
  ~0.7 s; small frames reached ~5 fps, and the screen redraws every frame.
- Custom `.K3Z` layouts work: upload with `62.x`, reboot with `97.` (about a minute; the USB port
  disappears and comes back). Delete files with `64./HOST/<NAME>`.
- In our own layout, F-keys linked to 1x1-pixel visible buttons report reliably, and
  `clearenabled="true"` makes yellow report as `\x08`. All seven keys work; digits still don't.
- The app on this unit is **Unified Payment Platform 6.80.09-0034** (`22.` reply), Ingenico's
  Tetra-era successor to RBA. It speaks the RBA protocol but does **not** implement `26.x`
  Run Script: `26.<anything>` is ACKed and then ignored exactly like an undefined message
  (`98.`), even for a missing file. So nothing runs on the terminal without a host.
  (`maze_script.py` is kept as a record of the attempt; per the guide, scripts are
  state machines of `[tag]` screens with `button=<id>,[tag]` transitions and no variables.)
  Every program on the terminal must be signed by Ingenico; only unpackaged `/HOST` data files
  (forms, images, scripts) are exempt (guide section 2.4).
- `70.x` Update Form Element is ACKed but does not redraw labels on this unit. Put every
  `T<id>,<text>` override in the `24.x` request instead, keeping it under 247 bytes.
- A key press closes the on-screen form, so each frame is: upload `GAME.PNG`, `15.0` soft reset,
  `24.GAME.K3Z`; key presses arrive asynchronously as `24.0<key>`.
- Draw everything as full-screen images; text-grid/ASCII graphics look poor on this screen.
  Frames are 32-colour palette PNGs (~1.5 KB for flat game graphics vs ~15 KB as JPEG);
  a push takes ~0.25 s, mostly the soft reset + redraw rather than the upload.
- Labels keep their last text between screens (the `<?iv...?>` values persist), so set every
  label on every `24.x`. A `24.x` with overrides must stay under 247 bytes. Bold monospace at
  22 px renders ~20 px per character (only ~16 columns fit); 16 px fits ~21.
- After a reboot the terminal is offline ("This Lane Closed", `11.` -> `11.00Lane Closed`,
  and `15.0` answers `00.2000`). `01.00000000` goes online without changing versions. On-demand
  screens (`24.x`) work either way.
- Key beeps come from the layout: `entertone`/`cleartone`/`canceltone` on the form and
  `tonetype` on each button. Our layouts set them all to `0`.

### Sound and lights

- `51.<tone><length>` beeps work: tones `3`/`0`/`1`/`2` = 3800/4200/6000/9000 Hz, lengths
  `0`/`1`/`2` = 150/500/1000 ms. Fine for game sounds, too few notes for music.
- `72.x` audio-file playback: every play request answers `72.9`, even for a missing file
  (`72.0` stop answers `72.5`). The upload works (`63.` finds it), so this model can't play
  audio files - most likely a beeper, not a speaker.
- `92.x` lights (screen/keypad backlight, tap LEDs, card-slot lights): ACKed, never answered,
  and nothing visibly changes (watched with `light_test.py`).

### Card readers

- Card data: a read returns track data with the card number. Keep only the exit type and the
  reader letter; discard the rest without printing or storing it (`io_demo.card_event` does).
- `23.<prompt>[FS]<form>[FS][FS]<readers>` arms readers (`M` swipe, `S` chip, `C` tap) and can
  use our `GAME.K3Z` as its screen. Swipe and chip are enabled; contactless is disabled
  (`23.R`). `28.100004121` (variable 412 = 1, payment-only mode) enables contactless until the
  next reboot - a game that uses taps must set it at startup.
- Results seen with real cards: swipe -> `23.0M` (good read); chip insert -> `23.0S`; tap ->
  `23.0C` for some cards, `23.1` (bad read) for others and for Apple Pay; `23.N` (undocumented)
  when a chip card is pulled and on many taps - probably "card left before the read finished".
  Any of the tap results works as a "something was tapped" event.
- The terminal plays its own tone on contactless reads, and the pitch differed between cards:
  probably a success tone for good reads and an alert tone for failed ones (not verified).
- **Upload lock:** arming any reader with `23.x` (even with no card, even if cancelled) makes
  `62.x` uploads fail with `62.7`. `15.0`, `10.x` and `62.9` don't clear it;
  **`15.6` Stop Action does**, except while a chip card is still in the slot.
  `lane.write_file` sends `15.6` and retries automatically (prompting "Please remove card" on
  `MSG.K3Z` if the card is still in). Verified live: swipe, then the screen updates with no
  reboot; 10 taps in a row, each followed by a screen update.
- Chip insert is unreliable for games: once it returned `23.0S`, once the terminal started its
  own payment flow, never replied to `23.x`, and showed "Transaction cancelled" with the keys
  dead when the card was pulled. Use swipe and tap as game inputs, not chip insert.

### Running our own code on it

- Not possible on this unit. Secure boot and load-time checks only accept Ingenico-signed
  software, and opening the case trips tamper switches that wipe the keys. Only unpackaged
  `/HOST` data files (forms, images, scripts) are exempt from signing.
- No public exploit for Lane/3000 or Telium Tetra as of 2026-11. The closest work is on the
  older Telium 2 platform (Positive Technologies / Cyber R&D Lab, Black Hat EU 2020,
  CVE-2018-17765..17772), patched and not applicable to Tetra.

## Gotchas

- `lane.find_port()` takes the first `/dev/cu.usbmodem*`. With another USB serial device
  plugged in, check that `07.` answers `INGNAR`/`L3000` before trusting the port.
- When the terminal shows a stuck payment screen ("Transaction cancelled", keys dead), `15.6`
  returns it to idle.

## What's on the terminal now

- Added by us in `/HOST`: `GAME.K3Z`, `GAME.PNG`, `GAMEBTN.PNG` (remove with
  `game_screen.py --uninstall`).
- `AD13.JPG` (an ad slot) holds a test image; the original is in `backups/AD13.JPG`
  (restore with `show_image.py --restore`).
- No settings were changed. Variable 412 (contactless) resets on reboot.

Reference: Ingenico *Telium RBA Developer's Guide* Rev 17.6 (DIV350779), public on
developer.ingenico.us.
