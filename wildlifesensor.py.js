#!/usr/bin/env ts-node
/**
 * wildlifesensor.ts
 * -----------------
 * Raspberry Pi wildlife camera trap.
 *
 * Hardware
 * --------
 * - PIR motion sensor on GPIO 4
 * - Raspberry Pi Camera Module (any revision)
 *
 * Behaviour
 * ---------
 * 1. Wait for motion.
 * 2. Start recording an H.264 video file with a timestamp-based name.
 * 3. Keep recording for at least MIN_RECORD_SECONDS.
 * 4. Keep recording until motion stops (or MAX_RECORD_SECONDS is reached).
 * 5. Stop recording, log the clip, then go back to step 1.
 *
 * All errors are caught so the sensor keeps running unattended.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, execFile, ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// Third-party imports – fail early with a helpful message if missing
// ---------------------------------------------------------------------------

// onoff: npm install onoff
let Gpio: any;
try {
  Gpio = require("onoff").Gpio;
} catch (exc) {
  console.error(
    `[FATAL] onoff not available: ${exc}  (run: npm install onoff)`
  );
  process.exit(1);
}

// raspivid is used for camera recording (part of Raspberry Pi OS, not an npm package)
// We verify it exists at startup inside _openCamera().

// ---------------------------------------------------------------------------
// Configuration – change these without touching the logic below
// ---------------------------------------------------------------------------
const GPIO_PIN: number = 4; // BCM pin number for the PIR DATA line
const PIR_QUEUE_LEN: number = 5; // samples the PIR averages before firing
const CAMERA_RESOLUTION: [number, number] = [1280, 720];
const CAMERA_FRAMERATE: number = 30;
const VIDEO_DIR: string = "/home/pi/wildlife_videos"; // where clips are saved
const MIN_RECORD_SECONDS: number = 10.0; // always record at least this long
const MAX_RECORD_SECONDS: number = 300.0; // hard cap so a stuck PIR doesn't fill the disk
const NO_MOTION_TIMEOUT: number = 30.0; // give up waiting for motion-end after this many s
const LOG_FILE: string = path.join(VIDEO_DIR, "sensor.log");
const MIN_FREE_MB: number = 200; // refuse to start a clip if less than this is available

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function _configureLogging(): void {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

function _formatLogLine(level: string, message: string): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
  return `${ts}  ${level.padEnd(8)}  ${message}`;
}

const _logStream: fs.WriteStream = (() => {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  return fs.createWriteStream(LOG_FILE, { flags: "a" });
})();

const log = {
  _write(level: string, message: string): void {
    const line = _formatLogLine(level, message);
    process.stdout.write(line + "\n");
    _logStream.write(line + "\n");
  },
  info(message: string, ...args: any[]): void {
    this._write("INFO", _interpolate(message, args));
  },
  warning(message: string, ...args: any[]): void {
    this._write("WARNING", _interpolate(message, args));
  },
  error(message: string, ...args: any[]): void {
    this._write("ERROR", _interpolate(message, args));
  },
  critical(message: string, ...args: any[]): void {
    this._write("CRITICAL", _interpolate(message, args));
  },
};

/** Very simple printf-style interpolation for %s, %d, %f */
function _interpolate(template: string, args: any[]): string {
  let i = 0;
  return template.replace(/%[sdif.0-9]*[sdif]/g, (match) => {
    if (i >= args.length) return match;
    const val = args[i++];
    if (match.includes(".") && match.endsWith("f")) {
      const decimals = parseInt(match.replace(/[^0-9]/g, "") || "6", 10);
      return typeof val === "number" ? val.toFixed(decimals) : String(val);
    }
    return String(val);
  });
}

_configureLogging();

// ---------------------------------------------------------------------------
// Graceful shutdown on SIGINT / SIGTERM
// ---------------------------------------------------------------------------
let _shutdownRequested: boolean = false;

function _handleSignal(signal: string): void {
  log.info(
    "Shutdown signal %s received – finishing current clip then exiting.",
    signal
  );
  _shutdownRequested = true;
}

process.on("SIGINT", () => _handleSignal("SIGINT"));
process.on("SIGTERM", () => _handleSignal("SIGTERM"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a unique timestamped H.264 path inside directory. */
function _makeFilename(directory: string): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const name = [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`,
  ].join("_") + ".h264";
  return path.join(directory, name);
}

/** Return free disk space in MB for the filesystem containing path. */
function _freeSpaceMb(filePath: string): number {
  try {
    // df -k outputs kilobytes; column 4 is available
    const out = execSync(`df -k "${filePath}"`, { encoding: "utf8" });
    const lines = out.trim().split("\n");
    if (lines.length < 2) return 0;
    const parts = lines[1].trim().split(/\s+/);
    const availKb = parseInt(parts[3], 10);
    return availKb / 1024;
  } catch {
    return 0;
  }
}

function _enoughDiskSpace(): boolean {
  const free = _freeSpaceMb(VIDEO_DIR);
  if (free < MIN_FREE_MB) {
    log.warning(
      "Low disk space: %.1f MB free (need %d MB) – skipping clip.",
      free,
      MIN_FREE_MB
    );
    return false;
  }
  return true;
}

/** Sleep for ms milliseconds, returns a Promise. */
function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** High-resolution monotonic time in seconds (mirrors time.monotonic()). */
function _monotonic(): number {
  const [sec, nano] = process.hrtime();
  return sec + nano / 1e9;
}

// ---------------------------------------------------------------------------
// PIR debounce queue (mirrors gpiozero MotionSensor queue_len behaviour)
// ---------------------------------------------------------------------------

class MotionSensorWrapper {
  private _gpio: any;
  private _queue: boolean[];
  private _queueLen: number;
  private _motionDetected: boolean = false;
  private _lastRisingMs: number = 0;

  constructor(pin: number, queueLen: number = 5) {
    this._queueLen = queueLen;
    this._queue = new Array(queueLen).fill(false);

    // Direction 'in', edge 'both', active high
    this._gpio = new Gpio(pin, "in", "both");

    this._gpio.watch((err: Error | null, value: number) => {
      if (err) return;
      this._queue.shift();
      this._queue.push(value === 1);
      this._motionDetected = this._queue.filter(Boolean).length > this._queueLen / 2;
      if (value === 1) {
        this._lastRisingMs = Date.now();
      }
    });
  }

  get motionDetected(): boolean {
    return this._motionDetected;
  }

  /**
   * Resolves true when motion is detected.
   * Resolves null (like Python's None) when timeout expires with no motion.
   */
  async waitForMotion(timeoutSeconds: number): Promise<true | null> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (this._motionDetected) return true;
      await _sleep(50);
    }
    return null;
  }

  /**
   * Waits until no motion is detected (or timeout expires).
   */
  async waitForNoMotion(timeoutSeconds: number): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (!this._motionDetected) return;
      await _sleep(50);
    }
  }

  unexport(): void {
    try {
      this._gpio.unexport();
    } catch {
      // ignore
    }
  }
}

// Module-level PIR instance (mirrors Python global `pir`)
let pir: MotionSensorWrapper;

// ---------------------------------------------------------------------------
// Camera wrapper (uses raspivid CLI)
// ---------------------------------------------------------------------------

interface Camera {
  startRecording(filepath: string): void;
  stopRecording(): Promise<void>;
  close(): void;
}

/** Verify raspivid is available and return a camera object. */
function _openCamera(): Camera {
  // Verify raspivid exists
  try {
    execSync("which raspivid", { encoding: "utf8" });
  } catch {
    throw new Error(
      "raspivid not found. Is this a Raspberry Pi with the camera enabled?"
    );
  }

  let _proc: ChildProcess | null = null;
  let _filepath: string | null = null;

  // Brief warm-up: capture a single frame to let the sensor settle
  try {
    execSync(
      `raspistill -o /dev/null -t 2000 -w ${CAMERA_RESOLUTION[0]} -h ${CAMERA_RESOLUTION[1]}`,
      { timeout: 10000 }
    );
  } catch {
    // Non-fatal: some setups may not support raspistill; log and continue
    log.warning("Camera warm-up via raspistill failed – continuing anyway.");
  }

  log.info(
    "Camera initialised at %dx%d @ %d fps.",
    CAMERA_RESOLUTION[0],
    CAMERA_RESOLUTION[1],
    CAMERA_FRAMERATE
  );

  return {
    startRecording(filepath: string): void {
      _filepath = filepath;
      // raspivid: -o output, -t 0 = run indefinitely, -w/-h resolution, -fps framerate
      _proc = execFile(
        "raspivid",
        [
          "-o", filepath,
          "-t", "0",
          "-w", String(CAMERA_RESOLUTION[0]),
          "-h", String(CAMERA_RESOLUTION[1]),
          "-fps", String(CAMERA_FRAMERATE),
        ],
        (err) => {
          if (err && !_shutdownRequested) {
            log.error("raspivid process error: %s", err.message);
          }
        }
      );
    },

    stopRecording(): Promise<void> {
      return new Promise((resolve) => {
        if (!_proc) {
          resolve();
          return;
        }
        _proc.once("close", () => resolve());
        try {
          _proc.kill("SIGTERM");
        } catch {
          resolve();
        }
      });
    },

    close(): void {
      if (_proc) {
        try {
          _proc.kill("SIGTERM");
        } catch {
          // ignore
        }
        _proc = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Core recording logic
// ---------------------------------------------------------------------------

async function recordClip(camera: Camera): Promise<void> {
  if (!_enoughDiskSpace()) {
    return;
  }

  const filepath = _makeFilename(VIDEO_DIR);
  log.info("Motion detected – recording → %s", path.basename(filepath));

  const startTime = _monotonic();
  let recording = false;

  try {
    camera.startRecording(filepath);
    recording = true;

    // ── Minimum buffer ──────────────────────────────────────────────────
    let elapsed = 0.0;
    while (elapsed < MIN_RECORD_SECONDS) {
      if (_shutdownRequested) break;
      await _sleep(100);
      elapsed = _monotonic() - startTime;
    }

    // ── Wait for motion to stop (with hard cap) ──────────────────────
    if (!_shutdownRequested) {
      let motionEndDeadline = _monotonic() + NO_MOTION_TIMEOUT;
      const maxDeadline = startTime + MAX_RECORD_SECONDS;

      while (!_shutdownRequested) {
        const nowMono = _monotonic();

        if (nowMono >= maxDeadline) {
          log.warning(
            "Max recording duration (%ds) reached – stopping.",
            MAX_RECORD_SECONDS
          );
          break;
        }

        // pir.motionDetected reflects the current debounced state
        if (!pir.motionDetected) {
          if (nowMono >= motionEndDeadline) {
            break; // motion has been absent long enough
          }
        } else {
          // Motion still ongoing – reset the no-motion deadline
          motionEndDeadline = _monotonic() + NO_MOTION_TIMEOUT;
        }

        await _sleep(100);
      }
    }
  } catch (exc: any) {
    log.error("Error during recording: %s", exc?.message ?? String(exc));
  } finally {
    if (recording) {
      try {
        await camera.stopRecording();
      } catch (exc: any) {
        log.error(
          "Error stopping recording: %s",
          exc?.message ?? String(exc)
        );
      }
    }
  }

  const duration = _monotonic() - startTime;
  let fileMb = 0.0;
  try {
    if (fs.existsSync(filepath)) {
      fileMb = fs.statSync(filepath).size / (1024 * 1024);
    }
  } catch {
    // ignore
  }
  log.info(
    "Clip saved: %s  (%.1f s, %.2f MB)",
    path.basename(filepath),
    duration,
    fileMb
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info("Wildlife sensor starting up.  Videos → %s", VIDEO_DIR);

  // Initialise PIR
  try {
    pir = new MotionSensorWrapper(GPIO_PIN, PIR_QUEUE_LEN);
  } catch (exc: any) {
    log.critical(
      "Could not initialise PIR on GPIO %d: %s",
      GPIO_PIN,
      exc?.message ?? String(exc)
    );
    process.exit(1);
  }

  log.info("PIR calibrating on GPIO %d …", GPIO_PIN);
  // Allow the PIR sensor to settle before we start listening
  await pir.waitForNoMotion(30);
  log.info("PIR ready.  Waiting for motion …");

  let camera: Camera | null = null;
  try {
    camera = _openCamera();

    while (!_shutdownRequested) {
      // waitForMotion accepts a timeout so we can check _shutdownRequested
      const detected = await pir.waitForMotion(5);
      if (detected === null) {
        // Timed out – no motion; loop again to check shutdown flag
        continue;
      }

      await recordClip(camera);

      if (!_shutdownRequested) {
        log.info("Motion ended – waiting for next event …");
      }
    }
  } catch (exc: any) {
    log.critical(
      "Unhandled exception in main loop: %s",
      exc?.message ?? String(exc)
    );
    process.exit(1);
  } finally {
    if (camera !== null) {
      try {
        camera.close();
        log.info("Camera closed.");
      } catch {
        // ignore
      }
    }
    try {
      pir.unexport();
    } catch {
      // ignore
    }
    log.info("Wildlife sensor shut down cleanly.");
    _logStream.end();
  }
}

main();
