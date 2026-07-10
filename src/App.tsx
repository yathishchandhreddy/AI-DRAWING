/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import Webcam from 'react-webcam';
import { Hands, Results, HAND_CONNECTIONS } from '@mediapipe/hands';
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';
import { Camera as MediaPipeCamera } from '@mediapipe/camera_utils';
import { 
  Eraser, 
  RotateCcw, 
  Palette, 
  Circle, 
  Camera, 
  CameraOff,
  Download,
  Info
} from 'lucide-react';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';

const COLORS = [
  '#ef4444', // Red
  '#22c55e', // Green
  '#3b82f6', // Blue
  '#eab308', // Yellow
  '#a855f7', // Purple
  '#ec4899', // Pink
  '#ffffff', // White
];

const BRUSH_SIZES = [2, 5, 10, 15, 20];

const WebcamAny = Webcam as any;

export default function App() {
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  
  // State for UI
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [color, setColor] = useState(COLORS[0]);
  const [brushSize, setBrushSize] = useState(5);
  const [opacity, setOpacity] = useState(1);
  const [brushShape, setBrushShape] = useState<'round' | 'square' | 'butt'>('round');
  const [showInfo, setShowInfo] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);

  // Refs for drawing state to avoid stale closures in the MediaPipe callback
  // Now supports multiple hands
  const drawingStateRef = useRef<{
    [key: number]: {
      isDrawing: boolean;
      lastPos: { x: number; y: number } | null;
      lastMidPoint: { x: number; y: number } | null;
      smoothedPos: { x: number; y: number } | null;
      currentWidth: number;
    }
  }>({});

  const colorRef = useRef(color);
  const brushSizeRef = useRef(brushSize);
  const opacityRef = useRef(opacity);
  const brushShapeRef = useRef(brushShape);

  // Keep refs in sync with state
  useEffect(() => {
    colorRef.current = color;
    brushSizeRef.current = brushSize;
    opacityRef.current = opacity;
    brushShapeRef.current = brushShape;
  }, [color, brushSize, opacity, brushShape]);

  const draw3DBezier = (
    ctx: CanvasRenderingContext2D, 
    x1: number, y1: number, 
    cx: number, cy: number, 
    x2: number, y2: number, 
    color: string, size: number, opacity: number
  ) => {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.lineCap = brushShapeRef.current;
    ctx.lineJoin = brushShapeRef.current === 'round' ? 'round' : 'miter';

    // 1. Base Shadow/Depth Layer
    ctx.beginPath();
    ctx.moveTo(x1 + 2, y1 + 2);
    ctx.quadraticCurveTo(cx + 2, cy + 2, x2 + 2, y2 + 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = size;
    ctx.stroke();

    // 2. Main Color Layer
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.stroke();

    // 3. Highlight Layer
    ctx.beginPath();
    ctx.moveTo(x1 - size/5, y1 - size/5);
    ctx.quadraticCurveTo(cx - size/5, cy - size/5, x2 - size/5, y2 - size/5);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = size / 2.5;
    ctx.stroke();

    ctx.restore();
  };

  const onResults = useCallback((results: Results) => {
    if (!canvasRef.current || !drawingCanvasRef.current || !webcamRef.current?.video) return;

    const canvasCtx = canvasRef.current.getContext('2d', { alpha: true });
    const drawingCtx = drawingCanvasRef.current.getContext('2d', { willReadFrequently: true });
    if (!canvasCtx || !drawingCtx) return;

    const width = canvasRef.current.width;
    const height = canvasRef.current.height;

    // Clear the tracking canvas
    canvasCtx.clearRect(0, 0, width, height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      results.multiHandLandmarks.forEach((landmarks, index) => {
        if (!drawingStateRef.current[index]) {
          drawingStateRef.current[index] = {
            isDrawing: false,
            lastPos: null,
            lastMidPoint: null,
            smoothedPos: null,
            currentWidth: brushSizeRef.current,
          };
        }

        const state = drawingStateRef.current[index];

        const indexTip = landmarks[8];
        const indexPip = landmarks[6];
        const middleTip = landmarks[12];
        const middlePip = landmarks[10];

        const rawX = (1 - indexTip.x) * width;
        const rawY = indexTip.y * height;

        // Enhanced Smoothing for Writing
        let alpha = 0.8; 
        let speed = 0;
        if (state.smoothedPos) {
          const dx = rawX - state.smoothedPos.x;
          const dy = rawY - state.smoothedPos.y;
          speed = Math.sqrt(dx * dx + dy * dy);
          // Writing letters needs high responsiveness but also jitter removal
          alpha = speed > 15 ? 0.95 : (speed > 5 ? 0.85 : 0.65);
        }

        if (!state.smoothedPos) {
          state.smoothedPos = { x: rawX, y: rawY };
        } else {
          state.smoothedPos = {
            x: alpha * rawX + (1 - alpha) * state.smoothedPos.x,
            y: alpha * rawY + (1 - alpha) * state.smoothedPos.y,
          };
        }

        const x = state.smoothedPos.x;
        const y = state.smoothedPos.y;

        // Draw hand indicator
        canvasCtx.beginPath();
        canvasCtx.arc(x, y, 8, 0, Math.PI * 2);
        canvasCtx.fillStyle = index === 0 ? 'rgba(0, 255, 0, 0.4)' : 'rgba(59, 130, 246, 0.4)';
        canvasCtx.fill();

        // Gesture Detection
        const getDistance = (p1: any, p2: any) => {
          return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2) + Math.pow(p1.z - p2.z, 2));
        };

        const indexLength = getDistance(indexTip, indexPip);
        const middleLength = getDistance(middleTip, middlePip);
        const isDrawingGesture = indexTip.y < indexPip.y && (middleTip.y > middlePip.y || middleLength < indexLength * 0.65);

        if (isDrawingGesture) {
          if (!state.isDrawing) {
            state.isDrawing = true;
            state.lastPos = { x, y };
            state.lastMidPoint = { x, y };
            state.currentWidth = brushSizeRef.current;
          } else if (state.lastPos && state.lastMidPoint) {
            const dist = Math.sqrt(Math.pow(x - state.lastPos.x, 2) + Math.pow(y - state.lastPos.y, 2));
            
            if (dist < 120) { 
              // Velocity-sensitive width (thinner when fast, thicker when slow)
              const targetWidth = brushSizeRef.current * (1 - Math.min(speed / 50, 0.4));
              state.currentWidth = 0.8 * state.currentWidth + 0.2 * targetWidth;

              const midPoint = {
                x: (state.lastPos.x + x) / 2,
                y: (state.lastPos.y + y) / 2
              };

              // Draw smooth curve using Quadratic Bezier
              draw3DBezier(
                drawingCtx,
                state.lastMidPoint.x, state.lastMidPoint.y,
                state.lastPos.x, state.lastPos.y,
                midPoint.x, midPoint.y,
                colorRef.current,
                state.currentWidth,
                opacityRef.current
              );

              state.lastMidPoint = midPoint;
            }
            
            state.lastPos = { x, y };
          }
        } else {
          state.isDrawing = false;
          state.lastPos = null;
          state.lastMidPoint = null;
          
          canvasCtx.beginPath();
          canvasCtx.arc(x, y, brushSizeRef.current / 2 + 3, 0, Math.PI * 2);
          canvasCtx.strokeStyle = colorRef.current;
          canvasCtx.lineWidth = 1.5;
          canvasCtx.stroke();
        }
      });

      Object.keys(drawingStateRef.current).forEach(key => {
        const idx = parseInt(key);
        if (idx >= results.multiHandLandmarks.length) {
          delete drawingStateRef.current[idx];
        }
      });
    } else {
      drawingStateRef.current = {};
    }
  }, []);

  // Initialize MediaPipe Hands and start processing loop
  useEffect(() => {
    if (!isCameraOn || !cameraReady) return;

    let isMounted = true;
    let hands: Hands | null = null;
    let camera: MediaPipeCamera | null = null;

    try {
      hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });

      hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1, // Increased back to 1 for better accuracy/continuity
        minDetectionConfidence: 0.5, // Lowered slightly to prevent "missing parts"
        minTrackingConfidence: 0.5, // Lowered slightly to prevent "missing parts"
      });

      hands.onResults((results) => {
        if (isMounted) {
          onResults(results);
        }
      });

      if (webcamRef.current?.video) {
        camera = new MediaPipeCamera(webcamRef.current.video, {
          onFrame: async () => {
            if (webcamRef.current?.video && hands) {
              await hands.send({ image: webcamRef.current.video });
              setIsLoading(false);
            }
          },
          width: 1280,
          height: 720,
        });
        camera.start();
      }
    } catch (err) {
      console.error("Failed to initialize Hands:", err);
      setCameraError("Failed to initialize hand tracking. Please check your connection.");
      setIsLoading(false);
    }

    return () => {
      isMounted = false;
      if (hands) {
        hands.close();
      }
      if (camera) {
        camera.stop();
      }
    };
  }, [isCameraOn, cameraReady, onResults]);

  const clearCanvas = () => {
    if (!drawingCanvasRef.current) return;
    const ctx = drawingCanvasRef.current.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height);
    }
  };

  const downloadImage = () => {
    if (!drawingCanvasRef.current) return;
    const link = document.createElement('a');
    link.download = 'air-draw.png';
    link.href = drawingCanvasRef.current.toDataURL();
    link.click();
  };

  return (
    <div className="relative w-full h-screen bg-neutral-950 overflow-hidden font-sans text-white">
      {/* Loading Overlay */}
      <AnimatePresence>
        {(isLoading || cameraError) && (
          <motion.div 
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-neutral-950 p-8 text-center"
          >
            {cameraError ? (
              <>
                <div className="w-16 h-16 bg-red-500/20 text-red-500 rounded-full flex items-center justify-center mb-4">
                  <CameraOff className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-bold mb-2">Something went wrong</h2>
                <p className="text-neutral-400 max-w-md mb-6">{cameraError}</p>
                <button 
                  onClick={() => window.location.reload()}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-medium transition-colors"
                >
                  Reload Page
                </button>
              </>
            ) : (
              <>
                <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
                <p className="text-neutral-400 animate-pulse">Initializing Hand Tracking...</p>
                <p className="text-xs text-neutral-600 mt-4">This may take a few seconds to load AI models</p>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Viewport */}
      <div className="relative w-full h-full flex items-center justify-center">
        {/* Webcam Feed */}
        <div className="relative w-full max-w-5xl aspect-video bg-neutral-900 rounded-2xl overflow-hidden shadow-2xl border border-neutral-800">
          {isCameraOn ? (
            <WebcamAny
              ref={webcamRef}
              mirrored
              audio={false}
              screenshotFormat="image/png"
              onUserMedia={() => setCameraReady(true)}
              onUserMediaError={(err: any) => {
                console.error("Webcam error:", err);
                setCameraError("Could not access your camera. Please ensure you have granted permission.");
                setIsLoading(false);
              }}
              className="absolute inset-0 w-full h-full object-cover opacity-40 grayscale"
              videoConstraints={{
                width: 1280,
                height: 720,
                facingMode: "user"
              }}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
              <CameraOff className="w-16 h-16 text-neutral-700" />
            </div>
          )}

          {/* Drawing Canvas */}
          <canvas
            ref={drawingCanvasRef}
            width={1280}
            height={720}
            className="absolute inset-0 w-full h-full pointer-events-none"
          />

          {/* Tracking Overlay Canvas */}
          <canvas
            ref={canvasRef}
            width={1280}
            height={720}
            className="absolute inset-0 w-full h-full pointer-events-none"
          />
        </div>

        {/* Floating Controls */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-4 p-4 bg-neutral-900/80 backdrop-blur-md border border-neutral-800 rounded-2xl shadow-2xl">
          {/* Color Picker */}
          <div className="flex items-center gap-2 pr-4 border-r border-neutral-800">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={cn(
                  "w-8 h-8 rounded-full border-2 transition-all hover:scale-110",
                  color === c ? "border-white scale-110 shadow-lg" : "border-transparent"
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          {/* Brush Size */}
          <div className="flex items-center gap-2 pr-4 border-r border-neutral-800">
            {BRUSH_SIZES.map((size) => (
              <button
                key={size}
                onClick={() => setBrushSize(size)}
                className={cn(
                  "flex items-center justify-center rounded-lg transition-all hover:bg-neutral-800",
                  brushSize === size ? "bg-neutral-800 text-blue-400" : "text-neutral-500"
                )}
              >
                <div 
                  className="rounded-full bg-current" 
                  style={{ width: size + 2, height: size + 2 }} 
                />
              </button>
            ))}
          </div>

          {/* Opacity Control */}
          <div className="flex flex-col gap-1 pr-4 border-r border-neutral-800 min-w-[100px]">
            <span className="text-[10px] text-neutral-500 uppercase font-bold">Opacity</span>
            <input 
              type="range" 
              min="0.1" 
              max="1" 
              step="0.1" 
              value={opacity} 
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Brush Shape */}
          <div className="flex items-center gap-2 pr-4 border-r border-neutral-800">
            <button
              onClick={() => setBrushShape('round')}
              className={cn(
                "p-1.5 rounded-lg transition-all",
                brushShape === 'round' ? "bg-neutral-800 text-blue-400" : "text-neutral-500 hover:bg-neutral-800"
              )}
              title="Round Tip"
            >
              <Circle className="w-5 h-5 fill-current" />
            </button>
            <button
              onClick={() => setBrushShape('square')}
              className={cn(
                "p-1.5 rounded-lg transition-all",
                brushShape === 'square' ? "bg-neutral-800 text-blue-400" : "text-neutral-500 hover:bg-neutral-800"
              )}
              title="Square Tip"
            >
              <div className="w-4 h-4 bg-current rounded-sm" />
            </button>
            <button
              onClick={() => setBrushShape('butt')}
              className={cn(
                "p-1.5 rounded-lg transition-all",
                brushShape === 'butt' ? "bg-neutral-800 text-blue-400" : "text-neutral-500 hover:bg-neutral-800"
              )}
              title="Flat Tip"
            >
              <div className="w-4 h-1 bg-current" />
            </button>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={clearCanvas}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors"
              title="Clear Canvas"
            >
              <RotateCcw className="w-6 h-6" />
            </button>
            <button
              onClick={downloadImage}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors"
              title="Download Drawing"
            >
              <Download className="w-6 h-6" />
            </button>
            <button
              onClick={() => setIsCameraOn(!isCameraOn)}
              className={cn(
                "p-2 rounded-xl transition-colors",
                isCameraOn ? "text-neutral-400 hover:text-white hover:bg-neutral-800" : "text-red-400 bg-red-400/10 hover:bg-red-400/20"
              )}
              title={isCameraOn ? "Turn Camera Off" : "Turn Camera On"}
            >
              {isCameraOn ? <Camera className="w-6 h-6" /> : <CameraOff className="w-6 h-6" />}
            </button>
            <button
              onClick={() => setShowInfo(!showInfo)}
              className={cn(
                "p-2 rounded-xl transition-colors",
                showInfo ? "text-blue-400 bg-blue-400/10" : "text-neutral-400 hover:text-white hover:bg-neutral-800"
              )}
            >
              <Info className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Info Panel */}
        <AnimatePresence>
          {showInfo && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="absolute top-8 right-8 w-64 p-6 bg-neutral-900/90 backdrop-blur-md border border-neutral-800 rounded-2xl shadow-2xl"
            >
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Palette className="w-5 h-5 text-blue-400" />
                How to Draw
              </h3>
              <ul className="space-y-4 text-sm text-neutral-400">
                <li className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">1</div>
                  <p><span className="text-white font-medium">Both Hands:</span> You can now draw with both hands simultaneously!</p>
                </li>
                <li className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">2</div>
                  <p><span className="text-white font-medium">Extend Index Finger:</span> Raise only your index finger to start drawing with a <span className="text-blue-400">3D tubular effect</span>.</p>
                </li>
                <li className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">3</div>
                  <p><span className="text-white font-medium">Hover:</span> Raise index and middle fingers to move without drawing.</p>
                </li>
              </ul>
              <button 
                onClick={() => setShowInfo(false)}
                className="mt-6 w-full py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl transition-colors text-xs font-medium"
              >
                Got it!
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Branding */}
      <div className="absolute top-8 left-8">
        <h1 className="text-2xl font-bold tracking-tighter flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
            <Palette className="w-5 h-5 text-white" />
          </div>
          Mac Draw
        </h1>
        <p className="text-xs text-neutral-500 mt-1">Built by Yathishh • AI Hand Tracking Canvas</p>
      </div>
    </div>
  );
}
