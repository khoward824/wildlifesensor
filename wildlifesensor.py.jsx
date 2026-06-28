import React, { useState, useEffect, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// Configuration constants (mirrors Python config block)
// ---------------------------------------------------------------------------
const GPIO_PIN = 4;
const PIR_QUEUE_LEN = 5;
const PIR_CALIBRATION_TIMEOUT = 30;
const CAMERA_RESOLUTION = { width: 1280, height: 720 };
const CAMERA_FRAMERATE = 30;
const CAMERA_WARMUP_SECS = 2.0;
const CAMERA_ROTATION = 0;
const MIN_RECORD_SECONDS = 10.0;
const MAX_RECORD_SECONDS = 300.0;
const NO_MOTION_TIMEOUT = 30.0;
const MOTION_POLL_INTERVAL = 0.1;
const WAIT_MOTION_TIMEOUT = 5.0;
const MIN_FREE_MB = 200;

// ---------------------------------------------------------------------------
// Logging levels
// ---------------------------------------------------------------------------
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
};
const ACTIVE_LOG_LEVEL = LOG_LEVELS.INFO;

// ---------------------------------------------------------------------------
// Helper: generate timestamp string
// ---------------------------------------------------------------------------
function getTimestamp() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Helper: generate filename (mirrors _make_filename)
// ---------------------------------------------------------------------------
function makeFilename(existingNames) {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const base =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  let candidate = `${base}.h264`;
  let counter = 1;
  while (existingNames.has(candidate)) {
    candidate = `${base}_${String(counter).padStart(3, "0")}.h264`;
    counter++;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Helper: sleep (Promise-based)
// ---------------------------------------------------------------------------
function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// ---------------------------------------------------------------------------
// Helper: simulate free disk space check
// Always returns MIN_FREE_MB + 100 in simulation (enough space).
// ---------------------------------------------------------------------------
function getFreeDiskMB() {
  return MIN_FREE_MB + 100;
}

// ---------------------------------------------------------------------------
// Helper: simulate file size in MB based on duration
// ---------------------------------------------------------------------------
function estimateFileMB(durationSeconds) {
  // Rough estimate: ~2 Mbps H.264 at 720p
  const bitsPerSecond = 2 * 1024 * 1024;
  return (durationSeconds * bitsPerSecond) / 8 / (1024 * 1024);
}

// ---------------------------------------------------------------------------
// Sensor states
// ---------------------------------------------------------------------------
const SENSOR_STATE = {
  IDLE: "IDLE",
  CALIBRATING: "CALIBRATING",
  WAITING: "WAITING",
  RECORDING: "RECORDING",
  STOPPED: "STOPPED",
  ERROR: "ERROR",
};

// ---------------------------------------------------------------------------
// Main App Component
// ---------------------------------------------------------------------------
export default function WildlifeSensor() {
  // Core state
  const [sensorState, setSensorState] = useState(SENSOR_STATE.IDLE);
  const [logs, setLogs] = useState([]);
  const [clips, setClips] = useState([]); // clip index (mirrors clip_index.csv)
  const [motionActive, setMotionActive] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0); // seconds elapsed
  const [freeDiskMB, setFreeDiskMB] = useState(getFreeDiskMB());
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);
  const [pirQueueSamples, setPirQueueSamples] = useState(
    Array(PIR_QUEUE_LEN).fill(false)
  ); // simulates PIR debounce queue

  // Refs for mutable state accessed inside async loops
  const shutdownRef = useRef(false);
  const motionActiveRef = useRef(false);
  const sensorStateRef = useRef(SENSOR_STATE.IDLE);
  const consecutiveErrorsRef = useRef(0);
  const existingNamesRef = useRef(new Set());
  const runningRef = useRef(false);
  const pirQueueRef = useRef(Array(PIR_QUEUE_LEN).fill(false));
  const manualMotionRef = useRef(false); // set by user clicking "Trigger Motion"
  const loopCancelRef = useRef(null); // cancellation token for the main loop

  // Sync refs with state where needed
  useEffect(() => {
    sensorStateRef.current = sensorState;
  }, [sensorState]);

  useEffect(() => {
    consecutiveErrorsRef.current = consecutiveErrors;
  }, [consecutiveErrors]);

  // Auto-scroll log
  const logEndRef = useRef(null);
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  // ---------------------------------------------------------------------------
  // Logging (mirrors Python log.info / log.warning / log.error / log.critical)
  // ---------------------------------------------------------------------------
  const addLog = useCallback((level, message) => {
    if (LOG_LEVELS[level] < ACTIVE_LOG_LEVEL) return;
    const entry = {
      id: Date.now() + Math.random(),
      timestamp: getTimestamp(),
      level,
      message,
    };
    setLogs((prev) => [...prev.slice(-499), entry]); // keep last 500
  }, []);

  const log = useRef({
    debug: (msg) => addLog("DEBUG", msg),
    info: (msg) => addLog("INFO", msg),
    warning: (msg) => addLog("WARNING", msg),
    error: (msg) => addLog("ERROR", msg),
    critical: (msg) => addLog("CRITICAL", msg),
  });

  // Keep log ref up to date with addLog closure
  useEffect(() => {
    log.current = {
      debug: (msg) => addLog("DEBUG", msg),
      info: (msg) => addLog("INFO", msg),
      warning: (msg) => addLog("WARNING", msg),
      error: (msg) => addLog("ERROR", msg),
      critical: (msg) => addLog("CRITICAL", msg),
    };
  }, [addLog]);

  // ---------------------------------------------------------------------------
  // PIR debounce simulation (mirrors queue_len averaging)
  // Samples are pushed by the "Trigger Motion" button and auto-decay
  // ---------------------------------------------------------------------------
  const pushPirSample = useCallback((value) => {
    pirQueueRef.current = [...pirQueueRef.current.slice(1), value];
    const trueCount = pirQueueRef.current.filter(Boolean).length;
    const debounced = trueCount > PIR_QUEUE_LEN / 2;
    motionActiveRef.current = debounced;
    setMotionActive(debounced);
    setPirQueueSamples([...pirQueueRef.current]);
  }, []);

  // ---------------------------------------------------------------------------
  // Simulate PIR reading (mirrors pir.motion_detected)
  // Returns current debounced state
  // ---------------------------------------------------------------------------
  const readPirMotionDetected = useCallback(() => {
    return motionActiveRef.current;
  }, []);

  // ---------------------------------------------------------------------------
  // Simulate wait_for_motion (mirrors pir.wait_for_motion(timeout=...))
  // Returns true if motion detected within timeout, null on timeout
  // ---------------------------------------------------------------------------
  const waitForMotion = useCallback(async (timeoutSecs) => {
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
      if (shutdownRef.current) return null;
      if (motionActiveRef.current) return true;
      await sleep(MOTION_POLL_INTERVAL);
    }
    return null;
  }, []);

  // ---------------------------------------------------------------------------
  // Simulate wait_for_no_motion (mirrors pir.wait_for_no_motion(timeout=...))
  // ---------------------------------------------------------------------------
  const waitForNoMotion = useCallback(async (timeoutSecs) => {
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
      if (shutdownRef.current) return;
      if (!motionActiveRef.current) return;
      await sleep(MOTION_POLL_INTERVAL);
    }
    // Non-fatal timeout – mirrors Python behaviour
    throw new Error(`wait_for_no_motion timed out after ${timeoutSecs}s`);
  }, []);

  // ---------------------------------------------------------------------------
  // Simulate disk space check (mirrors _enough_disk_space)
  // ---------------------------------------------------------------------------
  const enoughDiskSpace = useCallback(() => {
    const free = getFreeDiskMB();
    setFreeDiskMB(free);
    if (free < MIN_FREE_MB) {
      log.current.warning(
        `Low disk space: ${free.toFixed(1)} MB free (need ${MIN_FREE_MB} MB) – skipping clip.`
      );
      return false;
    }
    return true;
  }, []);

  // ---------------------------------------------------------------------------
  // Append clip index (mirrors _append_clip_index)
  // ---------------------------------------------------------------------------
  const appendClipIndex = useCallback((filename, duration, fileMB) => {
    const timestamp = getTimestamp();
    setClips((prev) => [
      ...prev,
      { timestamp, filename, duration_s: duration.toFixed(1), size_mb: fileMB.toFixed(3) },
    ]);
  }, []);

  // ---------------------------------------------------------------------------
  // Simulate camera warm-up (mirrors _open_camera)
  // ---------------------------------------------------------------------------
  const openCamera = useCallback(async () => {
    log.current.debug(`Camera warm-up (${CAMERA_WARMUP_SECS.toFixed(1)} s) …`);
    await sleep(CAMERA_WARMUP_SECS);
    log.current.info(
      `Camera initialised at ${CAMERA_RESOLUTION.width}x${CAMERA_RESOLUTION.height}` +
        ` @ ${CAMERA_FRAMERATE} fps (rotation=${CAMERA_ROTATION}°).`
    );
  }, []);

  // ---------------------------------------------------------------------------
  // record_clip – mirrors record_clip() exactly in logic
  // ---------------------------------------------------------------------------
  const recordClip = useCallback(async () => {
    if (!enoughDiskSpace()) {
      await sleep(1.0);
      return;
    }

    const filename = makeFilename(existingNamesRef.current);
    existingNamesRef.current.add(filename);
    const startTime = Date.now();
    let recording = false;

    log.current.info(`Motion detected – recording → ${filename}`);
    setSensorState(SENSOR_STATE.RECORDING);
    sensorStateRef.current = SENSOR_STATE.RECORDING;

    try {
      // Simulate camera.start_recording()
      recording = true;
      log.current.debug("camera.start_recording() called.");

      // ── Phase 1: Mandatory minimum recording window ──────────────────
      while (true) {
        const elapsed = (Date.now() - startTime) / 1000;
        setRecordingProgress(elapsed);
        if (elapsed >= MIN_RECORD_SECONDS) break;
        if (shutdownRef.current) {
          log.current.info("Shutdown requested during minimum buffer – stopping early.");
          break;
        }
        await sleep(MOTION_POLL_INTERVAL);
      }

      // ── Phase 2: Record until motion stops or hard cap ───────────────
      if (!shutdownRef.current) {
        let motionEndDeadline = Date.now() + NO_MOTION_TIMEOUT * 1000;
        const maxDeadline = startTime + MAX_RECORD_SECONDS * 1000;

        while (!shutdownRef.current) {
          const nowMs = Date.now();
          const elapsed = (nowMs - startTime) / 1000;
          setRecordingProgress(elapsed);

          // Hard cap check
          if (nowMs >= maxDeadline) {
            log.current.warning(
              `Maximum recording duration (${MAX_RECORD_SECONDS.toFixed(0)} s) reached – stopping.`
            );
            break;
          }

          // Read current debounced motion state
          let motionNow = false;
          try {
            motionNow = readPirMotionDetected();
          } catch (exc) {
            log.current.error(`Error reading PIR state: ${exc} – assuming no motion.`);
            motionNow = false;
          }

          if (motionNow) {
            // Motion still ongoing – push deadline forward
            motionEndDeadline = Date.now() + NO_MOTION_TIMEOUT * 1000;
            log.current.debug("Motion still active – resetting no-motion deadline.");
          } else {
            if (nowMs >= motionEndDeadline) {
              log.current.debug(`No motion for ${NO_MOTION_TIMEOUT.toFixed(0)} s – ending clip.`);
              break;
            }
          }

          await sleep(MOTION_POLL_INTERVAL);
        }
      }
    } catch (exc) {
      log.current.error(`Unexpected error during recording: ${exc}`);
    } finally {
      if (recording) {
        try {
          // Simulate camera.stop_recording()
          log.current.debug("camera.stop_recording() called.");
        } catch (exc) {
          log.current.error(`Unexpected error stopping recording: ${exc}`);
        }
      }
    }

    // ── Post-clip bookkeeping ─────────────────────────────────────────
    const duration = (Date.now() - startTime) / 1000;
    const fileMB = estimateFileMB(duration);

    // Simulate file existence check (always true in simulation)
    const fileExists = true;
    if (fileExists) {
      log.current.info(
        `Clip saved: ${filename}  (${duration.toFixed(1)} s, ${fileMB.toFixed(2)} MB)`
      );
      appendClipIndex(filename, duration, fileMB);

      // Warn if suspiciously small (mirrors Python check)
      if (fileMB < 0.01) {
        log.current.warning(
          `Clip ${filename} is very small (${fileMB.toFixed(3)} MB) – it may be corrupt.`
        );
      }
    } else {
      log.current.warning(`Expected clip file not found after recording: ${filename}`);
    }

    setRecordingProgress(0);
  }, [enoughDiskSpace, readPirMotionDetected, appendClipIndex]);

  // ---------------------------------------------------------------------------
  // Main loop – mirrors main() exactly in logic
  // ---------------------------------------------------------------------------
  const runSensor = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    shutdownRef.current = false;

    log.current.info("=".repeat(60));
    log.current.info("Wildlife sensor starting up.");
    log.current.info(`Free disk: ${getFreeDiskMB().toFixed(1)} MB`);
    log.current.info("=".repeat(60));

    // ── Initialise PIR ────────────────────────────────────────────────
    log.current.info(
      `PIR calibrating on GPIO ${GPIO_PIN} (up to ${PIR_CALIBRATION_TIMEOUT} s) …`
    );
    setSensorState(SENSOR_STATE.CALIBRATING);

    try {
      await waitForNoMotion(PIR_CALIBRATION_TIMEOUT);
      log.current.info("PIR calibration complete – ready.");
    } catch (exc) {
      log.current.warning(`PIR calibration wait failed (${exc}) – continuing anyway.`);
    }

    if (shutdownRef.current) {
      finishShutdown();
      return;
    }

    // ── Initialise camera ─────────────────────────────────────────────
    try {
      await openCamera();
    } catch (exc) {
      log.current.critical(`Cannot open camera: ${exc}`);
      setSensorState(SENSOR_STATE.ERROR);
      runningRef.current = false;
      return;
    }

    if (shutdownRef.current) {
      finishShutdown();
      return;
    }

    log.current.info("Waiting for motion …");
    setSensorState(SENSOR_STATE.WAITING);

    // ── Main detection / recording loop ───────────────────────────────
    let localConsecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 10;

    try {
      while (!shutdownRef.current) {
        let detected = null;
        try {
          detected = await waitForMotion(WAIT_MOTION_TIMEOUT);
        } catch (exc) {
          log.current.error(`Error waiting for motion: ${exc}`);
          await sleep(1.0);
          continue;
        }

        if (detected === null) {
          // Timed out – no motion; loop again to check shutdown flag
          continue;
        }

        // Motion detected – attempt to record a clip
        try {
          await recordClip();
          localConsecutiveErrors = 0;
          setConsecutiveErrors(0);
          consecutiveErrorsRef.current = 0;
        } catch (exc) {
          // record_clip() should not raise, but guard here as a safety net
          localConsecutiveErrors++;
          setConsecutiveErrors(localConsecutiveErrors);
          consecutiveErrorsRef.current = localConsecutiveErrors;
          log.current.error(
            `record_clip() raised unexpectedly (error ${localConsecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${exc}`
          );
          if (localConsecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            log.current.critical(
              "Too many consecutive errors – shutting down to avoid an infinite error loop."
            );
            break;
          }
          await sleep(2.0);
          continue;
        }

        if (!shutdownRef.current) {
          setSensorState(SENSOR_STATE.WAITING);
          log.current.info("Clip finished – waiting for next motion event …");
        }
      }
    } catch (exc) {
      log.current.critical(`Unhandled exception in main loop: ${exc}`);
    } finally {
      finishShutdown();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitForNoMotion, openCamera, waitForMotion, recordClip]);

  const finishShutdown = useCallback(() => {
    // Mirrors the finally block in main()
    log.current.info("Camera closed.");
    log.current.info("PIR closed.");
    log.current.info("Wildlife sensor shut down cleanly.");
    setSensorState(SENSOR_STATE.STOPPED);
    runningRef.current = false;
  }, []);

  // ---------------------------------------------------------------------------
  // Button handlers
  // ---------------------------------------------------------------------------
  const handleStart = useCallback(() => {
    if (runningRef.current) return;
    setLogs([]);
    setClips([]);
    setConsecutiveErrors(0);
    existingNamesRef.current = new Set();
    pirQueueRef.current = Array(PIR_QUEUE_LEN).fill(false);
    motionActiveRef.current = false;
    setMotionActive(false);
    setPirQueueSamples(Array(PIR_QUEUE_LEN).fill(false));
    runSensor();
  }, [runSensor]);

  const handleStop = useCallback(() => {
    if (!runningRef.current) return;
    shutdownRef.current = true;
    log.current.info("Shutdown signal received – finishing current clip then exiting.");
  }, []);

  // Simulate manual motion trigger (user physically waves at PIR)
  const handleTriggerMotion = useCallback(() => {
    if (sensorStateRef.current !== SENSOR_STATE.WAITING &&
        sensorStateRef.current !== SENSOR_STATE.RECORDING) return;
    // Push several "true" samples to saturate the queue (mirrors PIR firing)
    for (let i = 0; i < PIR_QUEUE_LEN; i++) {
      pirQueueRef.current = [...pirQueueRef.current.slice(1), true];
    }
    motionActiveRef.current = true;
    setMotionActive(true);
    setPirQueueSamples([...pirQueueRef.current]);

    // Auto-decay motion after 15 seconds (simulates subject leaving frame)
    setTimeout(() => {
      for (let i = 0; i < PIR_QUEUE_LEN; i++) {
        pirQueueRef.current = [...pirQueueRef.current.slice(1), false];
      }
      motionActiveRef.current = false;
      setMotionActive(false);
      setPirQueueSamples([...pirQueueRef.current]);
    }, 15000);
  }, []);

  const handleClearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------
  const stateColor = {
    [SENSOR_STATE.IDLE]: "#6b7280",
    [SENSOR_STATE.CALIBRATING]: "#f59e0b",
    [SENSOR_STATE.WAITING]: "#3b82f6",
    [SENSOR_STATE.RECORDING]: "#ef4444",
    [SENSOR_STATE.STOPPED]: "#6b7280",
    [SENSOR_STATE.ERROR]: "#dc2626",
  };

  const logLevelColor = {
    DEBUG: "#9ca3af",
    INFO: "#d1d5db",
    WARNING: "#fbbf24",
    ERROR: "#f87171",
    CRITICAL: "#ef4444",
  };

  const isRunning = sensorState !== SENSOR_STATE.IDLE && sensorState !== SENSOR_STATE.STOPPED;
  const canTrigger =
    sensorState === SENSOR_STATE.WAITING || sensorState === SENSOR_STATE.RECORDING;

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#111827",
        color: "#f9fafb",
        fontFamily: "'Courier New', Courier, monospace",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      {/* ── Header ── */}
      <div style={{ marginBottom: "24px" }}>
        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: "bold",
            color: "#10b981",
            margin: "0 0 4px 0",
          }}
        >
          🦉 Wildlife Sensor – Raspberry Pi Camera Trap
        </h1>
        <p style={{ color: "#6b7280", margin: 0, fontSize: "0.85rem" }}>
          Simulated port of wildlifesensor.py | GPIO {GPIO_PIN} PIR |{" "}
          {CAMERA_RESOLUTION.width}×{CAMERA_RESOLUTION.height} @ {CAMERA_FRAMERATE} fps
        </p>
      </div>

      {/* ── Status Bar ── */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "16px",
          alignItems: "center",
          backgroundColor: "#1f2937",
          borderRadius: "8px",
          padding: "12px 16px",
          marginBottom: "16px",
          border: `2px solid ${stateColor[sensorState]}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div
            style={{
              width: "12px",
              height: "12px",
              borderRadius: "50%",
              backgroundColor: stateColor[sensorState],
              boxShadow:
                sensorState === SENSOR_STATE.RECORDING
                  ? `0 0 8px ${stateColor[sensorState]}`
                  : "none",
              animation:
                sensorState === SENSOR_STATE.RECORDING ? "pulse 1s infinite" : "none",
            }}
          />
          <span
            style={{
              fontWeight: "bold",
              color: stateColor[sensorState],
              fontSize: "0.95rem",
            }}
          >
            {sensorState}
          </span>
        </div>

        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", fontSize: "0.85rem" }}>
          <span style={{ color: motionActive ? "#ef4444" : "#6b7280" }}>
            PIR: {motionActive ? "🔴 MOTION" : "⚫ CLEAR"}
          </span>
          <span style={{ color: "#9ca3af" }}>Disk: {freeDiskMB.toFixed(0)} MB free</span>
          {sensorState === SENSOR_STATE.RECORDING && (
            <span style={{ color: "#fbbf24" }}>
              Recording: {recordingProgress.toFixed(1)} s
              {recordingProgress < MIN_RECORD_SECONDS
                ? ` / min ${MIN_RECORD_SECONDS.toFixed(0)} s`
                : " (min buffer reached)"}
            </span>
          )}
          <span style={{ color: "#9ca3af" }}>Clips: {clips.length}</span>
          {consecutiveErrors > 0 && (
            <span style={{ color: "#ef4444" }}>Errors: {consecutiveErrors}</span>
          )}
        </div>
      </div>

      {/* ── PIR Queue Visualiser ── */}
      <div
        style={{
          backgroundColor: "#1f2937",
          borderRadius: "8px",
          padding: "10px 16px",
          marginBottom: "16px",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          fontSize: "0.8rem",
          color: "#9ca3af",
        }}
      >
        <span>PIR Queue (queue_len={PIR_QUEUE_LEN}):</span>
        {pirQueueSamples.map((v, i) => (
          <div
            key={i}
            style={{
              width: "18px",
              height: "18px",
              borderRadius: "3px",
              backgroundColor: v ? "#ef4444" : "#374151",
              border: "1px solid #4b5563",
            }}
            title={v ? "motion" : "clear"}
          />
        ))}
        <span style={{ color: "#6b7280", marginLeft: "4px" }}>
          → debounced: {motionActive ? "MOTION" : "CLEAR"}
        </span>
      </div>

      {/* ── Controls ── */}
      <div
        style={{
          display: "flex",
          gap: "10px",
          flexWrap: "wrap",
          marginBottom: "16px",
        }}
      >
        <button
          onClick={handleStart}
          disabled={isRunning}
          style={btnStyle(!isRunning, "#10b981", "#065f46")}
        >
          ▶ Start Sensor
        </button>
        <button
          onClick={handleStop}
          disabled={!isRunning}
          style={btnStyle(isRunning, "#ef4444", "#7f1d1d")}
        >
          ■ Stop (SIGTERM)
        </button>
        <button
          onClick={handleTriggerMotion}
          disabled={!canTrigger}
          style={btnStyle(canTrigger, "#f59e0b", "#78350f")}
        >
          🏃 Trigger Motion
        </button>
        <button
          onClick={handleClearLogs}
          style={btnStyle(true, "#6b7280", "#1f2937")}
        >
          🗑 Clear Logs
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "16px",
        }}
      >
        {/* ── Log Output ── */}
        <div>
          <h2
            style={{
              fontSize: "0.9rem",
              color: "#9ca3af",
              marginBottom: "6px",
              margin: "0 0 6px 0",
            }}
          >
            📋 Sensor Log (sensor.log)
          </h2>
          <div
            style={{
              backgroundColor: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: "6px",
              height: "420px",
              overflowY: "auto",
              padding: "8px",
              fontSize: "0.78rem",
              lineHeight: "1.6",
            }}
          >
            {logs.length === 0 && (
              <span style={{ color: "#4b5563" }}>No log entries yet…</span>
            )}
            {logs.map((entry) => (
              <div key={entry.id} style={{ color: logLevelColor[entry.level] }}>
                <span style={{ color: "#6b7280" }}>{entry.timestamp}</span>
                {"  "}
                <span
                  style={{
                    fontWeight: "bold",
                    minWidth: "70px",
                    display: "inline-block",
                  }}
                >
                  {entry.level.padEnd(8)}
                </span>
                {"  "}
                {entry.message}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* ── Clip Index ── */}
        <div>
          <h2
            style={{
              fontSize: "0.9rem",
              color: "#9ca3af",
              margin: "0 0 6px 0",
            }}
          >
            🎬 Clip Index (clip_index.csv)
          </h2>
          <div
            style={{
              backgroundColor: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: "6px",
              height: "420px",
              overflowY: "auto",
              fontSize: "0.78rem",
            }}
          >
            {clips.length === 0 ? (
              <div style={{ color: "#4b5563", padding: "8px" }}>
                No clips recorded yet…
              </div>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                }}
              >
                <thead>
                  <tr
                    style={{
                      backgroundColor: "#1e293b",
                      position: "sticky",
                      top: 0,
                    }}
                  >
                    {["timestamp", "filename", "duration_s", "size_mb"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "4px 8px",
                          color: "#6b7280",
                          fontWeight: "normal",
                          borderBottom: "1px solid #374151",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {clips.map((clip, i) => (
                    <tr
                      key={i}
                      style={{
                        backgroundColor: i % 2 === 0 ? "transparent" : "#0d1b2e",
                      }}
                    >
                      <td style={cellStyle}>{clip.timestamp}</td>
                      <td style={{ ...cellStyle, color: "#10b981" }}>{clip.filename}</td>
                      <td style={cellStyle}>{clip.duration_s}</td>
                      <td style={cellStyle}>{clip.size_mb}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* ── Config Reference ── */}
      <div
        style={{
          marginTop: "16px",
          backgroundColor: "#1f2937",
          borderRadius: "8px",
          padding: "12px 16px",
          fontSize: "0.75rem",
          color: "#6b7280",
        }}
      >
        <strong style={{ color: "#9ca3af" }}>Configuration: </strong>
        GPIO_PIN={GPIO_PIN} | MIN_RECORD={MIN_RECORD_SECONDS}s |
        MAX_RECORD={MAX_RECORD_SECONDS}s | NO_MOTION_TIMEOUT={NO_MOTION_TIMEOUT}s |
        MIN_FREE_MB={MIN_FREE_MB} | PIR_QUEUE_LEN={PIR_QUEUE_LEN} |
        PIR_CALIBRATION_TIMEOUT={PIR_CALIBRATION_TIMEOUT}s |
        CAMERA_WARMUP={CAMERA_WARMUP_SECS}s
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------
function btnStyle(enabled, activeColor, disabledBg) {
  return {
    padding: "8px 16px",
    borderRadius: "6px",
    border: "none",
    cursor: enabled ? "pointer" : "not-allowed",
    backgroundColor: enabled ? activeColor : disabledBg,
    color: enabled ? "#fff" : "#4b5563",
    fontFamily: "inherit",
    fontSize: "0.875rem",
    fontWeight: "bold",
    transition: "opacity 0.15s",
    opacity: enabled ? 1 : 0.5,
  };
}

const cellStyle = {
  padding: "3px 8px",
  color: "#d1d5db",
  borderBottom: "1px solid #1e293b",
};
