/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Camera, 
  Shield, 
  ShieldAlert, 
  ShieldCheck, 
  History, 
  Settings, 
  Video, 
  Image as ImageIcon,
  AlertTriangle,
  Play,
  Loader2,
  Upload,
  Download,
  Volume2,
  VolumeX
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import Markdown from 'react-markdown';
import { cn } from './lib/utils';

// --- Types ---

interface DetectionEvent {
  id: string;
  timestamp: Date;
  image: string;
  isSuspicious: boolean;
  reason: string;
}

// --- Constants ---

const MOTION_THRESHOLD = 30; // Sensitivity
const DETECTION_COOLDOWN = 1500; // 1.5 seconds between AI checks
const GEMINI_MODEL = "gemini-3-flash-preview";

export default function App() {
  // --- State ---
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isSuspicious, setIsSuspicious] = useState(false);
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [activeTab, setActiveTab] = useState<'live' | 'history'>('live');
  const [isMuted, setIsMuted] = useState(false);
  const [sensitivity, setSensitivity] = useState(85);
  const [audioSensitivity, setAudioSensitivity] = useState(60);
  const [isSmartGuard, setIsSmartGuard] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lastMotionDetected, setLastMotionDetected] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  
  // Refs for motion detection
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevFrameRef = useRef<ImageData | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const lastDetectionTimeRef = useRef<number>(0);
  const alarmAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [currentMotionLevel, setCurrentMotionLevel] = useState(0);

  // --- AI Initialization ---
  const getAI = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  // --- Audio Setup ---
  useEffect(() => {
    alarmAudioRef.current = new Audio('https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg');
    alarmAudioRef.current.loop = true;
    return () => {
      alarmAudioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (isSuspicious && !isMuted) {
      alarmAudioRef.current?.play().catch(() => {});
    } else {
      alarmAudioRef.current?.pause();
    }
  }, [isSuspicious, isMuted]);

  // --- Camera & Motion Logic ---

  const startCamera = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setStream(s);
      setIsMonitoring(true);

      // Audio Setup
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(s);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

    } catch (err) {
      console.error("Error accessing camera/mic:", err);
      alert("Camera/Microphone access denied or not available. Please ensure you have granted permissions.");
    }
  };

  const stopCamera = () => {
    stream?.getTracks().forEach(track => track.stop());
    audioContextRef.current?.close();
    setStream(null);
    setIsMonitoring(false);
    setIsSuspicious(false);
  };

  useEffect(() => {
    if (isMonitoring && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [isMonitoring, stream]);

  const analyzeFrame = useCallback(async (base64Image: string, triggerSource: 'motion' | 'sound' = 'motion') => {
    if (isAnalyzing) return;
    setIsAnalyzing(true);
    
    try {
      const ai = getAI();
      // Simplified and more direct prompt to avoid AI over-thinking
      const prompt = "Is there a human being visible in this security frame? Look closely at the entire image. If you see even a part of a person, respond with isSuspicious: true. Respond ONLY in JSON: { \"isSuspicious\": boolean, \"reason\": \"short description of what you see\" }";

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "image/jpeg", data: base64Image.split(',')[1] } }
            ]
          }
        ],
        config: { 
          responseMimeType: "application/json",
          // Use standard thinking for better accuracy if low-latency is failing
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });

      const text = response.text || "{}";
      const result = JSON.parse(text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1));
      
      if (result.isSuspicious) {
        setIsSuspicious(true);
        const newEvent: DetectionEvent = {
          id: Math.random().toString(36).substr(2, 9),
          timestamp: new Date(),
          image: base64Image,
          isSuspicious: true,
          reason: result.reason || "Person detected"
        };
        setEvents(prev => [newEvent, ...prev].slice(0, 50));
      }
    } catch (err) {
      console.error("AI Analysis failed:", err);
    } finally {
      setIsAnalyzing(false);
    }
  }, [isAnalyzing]);

  useEffect(() => {
    let animationFrame: number;
    
    const detectMotion = () => {
      if (!isMonitoring || !videoRef.current || !canvasRef.current) return;

      const now = Date.now();
      
      // Audio Level Detection
      if (analyserRef.current) {
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        // Use peak level instead of average to catch sharp sounds like footsteps
        const max = Math.max(...Array.from(dataArray));
        const normalizedLevel = (max / 255) * 100;
        setAudioLevel(normalizedLevel);

        if (normalizedLevel > (100 - audioSensitivity)) {
          if (now - lastDetectionTimeRef.current > (isSmartGuard ? 1000 : 300)) {
            lastDetectionTimeRef.current = now;
            const video = videoRef.current;
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const snapshot = canvas.toDataURL('image/jpeg', 0.5);
              
              if (isSmartGuard) {
                analyzeFrame(snapshot, 'sound');
              } else {
                setIsSuspicious(true);
                const newEvent: DetectionEvent = {
                  id: Math.random().toString(36).substr(2, 9),
                  timestamp: new Date(),
                  image: snapshot,
                  isSuspicious: true,
                  reason: "Instant Sound Alert"
                };
                setEvents(prev => [newEvent, ...prev].slice(0, 50));
              }
            }
          }
        }
      }

      // Only process motion every 100ms to make differences more apparent
      if (now - lastFrameTimeRef.current < 100) {
        animationFrame = requestAnimationFrame(detectMotion);
        return;
      }
      lastFrameTimeRef.current = now;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      // Draw current video frame to canvas
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const currentFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);

      if (prevFrameRef.current) {
        let diff = 0;
        const data = currentFrame.data;
        const prevData = prevFrameRef.current.data;

        // Sample every 4th pixel (2x2 grid) for better noise rejection and performance
        for (let i = 0; i < data.length; i += 16) {
          const rDiff = Math.abs(data[i] - prevData[i]);
          const gDiff = Math.abs(data[i+1] - prevData[i+1]);
          const bDiff = Math.abs(data[i+2] - prevData[i+2]);
          
          // Higher threshold for individual pixel noise (45 instead of 20)
          if (rDiff + gDiff + bDiff > 45) diff++;
        }

        // Calculate motion level based on the sampled grid
        const motionLevel = (diff / (canvas.width * canvas.height / 4)) * 100;
        setCurrentMotionLevel(motionLevel);

        // Adjusted threshold mapping to prevent "triggering on nothing" at high sensitivity
        // Even at 99%, we require at least 0.5% of the screen to move
        const threshold = Math.max(0.5, (100 - sensitivity) / 2);

        if (motionLevel > threshold) {
          setLastMotionDetected(true);
          setTimeout(() => setLastMotionDetected(false), 1000);
          
          if (now - lastDetectionTimeRef.current > (isSmartGuard ? 1000 : 300)) {
            lastDetectionTimeRef.current = now;
            
            // Use a smaller, faster snapshot for AI analysis
            const snapshot = canvas.toDataURL('image/jpeg', 0.5);
            
            if (isSmartGuard) {
              analyzeFrame(snapshot);
            } else {
              setIsSuspicious(true);
              const newEvent: DetectionEvent = {
                id: Math.random().toString(36).substr(2, 9),
                timestamp: new Date(),
                image: snapshot,
                isSuspicious: true,
                reason: "Instant Motion Alert"
              };
              setEvents(prev => [newEvent, ...prev].slice(0, 50));
            }
          }
        }
      }

      prevFrameRef.current = currentFrame;
      animationFrame = requestAnimationFrame(detectMotion);
    };

    if (isMonitoring) {
      animationFrame = requestAnimationFrame(detectMotion);
    }

    return () => cancelAnimationFrame(animationFrame);
  }, [isMonitoring, sensitivity, analyzeFrame]);

  // --- UI Components ---

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Shield className="text-black w-6 h-6" />
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight">SentryAI</h1>
              <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Live Motion Guard</p>
            </div>
          </div>

          <nav className="hidden md:flex items-center gap-1 bg-white/5 p-1 rounded-full border border-white/10">
            {[
              { id: 'live', label: 'Live Monitor', icon: Camera },
              { id: 'history', label: 'Event Log', icon: History },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={cn(
                  "flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium transition-all",
                  activeTab === tab.id 
                    ? "bg-white text-black shadow-sm" 
                    : "text-zinc-400 hover:text-white hover:bg-white/5"
                )}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-4">
            <button 
              onClick={() => setIsMuted(!isMuted)}
              className="p-2 rounded-full hover:bg-white/5 text-zinc-400 transition-colors"
            >
              {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
            <div className="h-4 w-px bg-white/10" />
            <div className="flex items-center gap-2">
              <div className={cn(
                "w-2 h-2 rounded-full animate-pulse",
                isMonitoring ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" : "bg-zinc-700"
              )} />
              <span className="text-xs font-mono text-zinc-500 uppercase tracking-wider">
                {isMonitoring ? "System Active" : "Standby"}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <AnimatePresence mode="wait">
          {activeTab === 'live' && (
            <motion.div 
              key="live"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-8"
            >
              {/* Main Feed */}
              <div className="lg:col-span-2 space-y-6">
                <div className="relative aspect-video bg-zinc-900 rounded-3xl overflow-hidden border border-white/10 shadow-2xl group">
                  {!isMonitoring ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-zinc-900/80 backdrop-blur-sm">
                      <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                        <Camera className="w-10 h-10 text-emerald-500" />
                      </div>
                      <div className="text-center space-y-2">
                        <h3 className="text-xl font-semibold">Camera Offline</h3>
                        <p className="text-zinc-500 text-sm max-w-xs">Initialize your secure feed to start AI-powered motion tracking.</p>
                      </div>
                      <button 
                        onClick={startCamera}
                        className="px-8 py-3 bg-emerald-500 text-black font-bold rounded-2xl hover:bg-emerald-400 transition-all active:scale-95 shadow-lg shadow-emerald-500/20"
                      >
                        Start Monitoring
                      </button>
                    </div>
                  ) : (
                    <>
                      <video 
                        ref={videoRef} 
                        autoPlay 
                        muted 
                        playsInline 
                        className="w-full h-full object-cover"
                      />
                      <canvas ref={canvasRef} width="640" height="480" className="hidden" />
                      
                      {/* Overlay UI */}
                      <div className="absolute top-6 left-6 flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                          <div className="px-3 py-1.5 bg-black/60 backdrop-blur-md rounded-lg border border-white/10 flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-[10px] font-mono uppercase tracking-widest font-bold">Live Feed</span>
                          </div>
                          {lastMotionDetected && !isSuspicious && (
                            <div className="px-3 py-1.5 bg-yellow-500/20 backdrop-blur-md rounded-lg border border-yellow-500/30 flex items-center gap-2">
                              <span className="text-[10px] font-mono uppercase tracking-widest font-bold text-yellow-500">Motion Detected</span>
                            </div>
                          )}
                          {isAnalyzing && (
                            <div className="px-3 py-1.5 bg-emerald-500/20 backdrop-blur-md rounded-lg border border-emerald-500/30 flex items-center gap-2 animate-pulse">
                              <Loader2 className="w-3 h-3 text-emerald-500 animate-spin" />
                              <span className="text-[10px] font-mono uppercase tracking-widest font-bold text-emerald-500">AI Scanning...</span>
                            </div>
                          )}
                        </div>
                        
                        {/* Motion Bar */}
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between text-[8px] font-bold uppercase tracking-tighter text-zinc-500">
                            <span>Motion</span>
                            <span>{Math.round(currentMotionLevel)}%</span>
                          </div>
                          <div className="w-32 h-1 bg-black/40 rounded-full overflow-hidden border border-white/5">
                            <motion.div 
                              animate={{ width: `${Math.min(currentMotionLevel * 5, 100)}%` }}
                              className={cn(
                                "h-full transition-colors",
                                currentMotionLevel > (100 - sensitivity) ? "bg-red-500" : "bg-emerald-500"
                              )}
                            />
                          </div>
                        </div>

                        {/* Audio Bar */}
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between text-[8px] font-bold uppercase tracking-tighter text-zinc-500">
                            <span>Audio</span>
                            <span>{Math.round(audioLevel)}%</span>
                          </div>
                          <div className="w-32 h-1 bg-black/40 rounded-full overflow-hidden border border-white/5">
                            <motion.div 
                              animate={{ width: `${Math.min(audioLevel, 100)}%` }}
                              className={cn(
                                "h-full transition-colors",
                                audioLevel > (100 - audioSensitivity) ? "bg-red-500" : "bg-emerald-500"
                              )}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="absolute bottom-6 right-6">
                        <button 
                          onClick={stopCamera}
                          className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 rounded-xl text-xs font-bold uppercase tracking-wider backdrop-blur-md transition-all"
                        >
                          Stop Feed
                        </button>
                      </div>

                      {/* Alarm Overlay */}
                      <AnimatePresence>
                        {isSuspicious && (
                          <motion.div 
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 border-8 border-red-600/50 pointer-events-none animate-pulse flex items-center justify-center bg-red-600/10"
                          >
                            <div className="bg-red-600 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 pointer-events-auto">
                              <AlertTriangle className="w-8 h-8 animate-bounce" />
                              <div>
                                <h4 className="font-black text-xl uppercase tracking-tighter">Person Detected</h4>
                                <p className="text-xs font-medium opacity-80">Intruder alert triggered by AI</p>
                              </div>
                              <button 
                                onClick={() => setIsSuspicious(false)}
                                className="ml-4 p-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors"
                              >
                                Dismiss
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-6 bg-zinc-900/50 rounded-3xl border border-white/5 space-y-2">
                    <div className="flex items-center gap-2 text-zinc-500 mb-2">
                      <ShieldCheck className="w-4 h-4" />
                      <span className="text-[10px] uppercase font-bold tracking-widest">Status</span>
                    </div>
                    <p className="text-2xl font-bold">{isMonitoring ? "Secured" : "Idle"}</p>
                    <p className="text-xs text-zinc-500">AI Guard is {isMonitoring ? "watching" : "on standby"}</p>
                  </div>
                  <div className="p-6 bg-zinc-900/50 rounded-3xl border border-white/5 space-y-2">
                    <div className="flex items-center gap-2 text-zinc-500 mb-2">
                      <AlertTriangle className="w-4 h-4" />
                      <span className="text-[10px] uppercase font-bold tracking-widest">Alerts</span>
                    </div>
                    <p className="text-2xl font-bold text-red-500">{events.filter(e => e.isSuspicious).length}</p>
                    <p className="text-xs text-zinc-500">Suspicious events today</p>
                  </div>
                  <div className="p-6 bg-zinc-900/50 rounded-3xl border border-white/5 space-y-4">
                    <div className="flex items-center gap-2 text-zinc-500 mb-2">
                      <Settings className="w-4 h-4" />
                      <span className="text-[10px] uppercase font-bold tracking-widest">Controls</span>
                    </div>
                    
                    <div className="space-y-4">
                      <div className="flex items-center justify-between p-3 bg-black/40 rounded-2xl border border-white/5">
                        <div className="space-y-0.5">
                          <span className="text-xs font-bold text-zinc-300">Smart Guard</span>
                          <p className="text-[9px] text-zinc-500">AI filters for people only</p>
                        </div>
                        <button 
                          onClick={() => setIsSmartGuard(!isSmartGuard)}
                          className={cn(
                            "w-10 h-5 rounded-full relative transition-colors",
                            isSmartGuard ? "bg-emerald-500" : "bg-zinc-700"
                          )}
                        >
                          <motion.div 
                            animate={{ x: isSmartGuard ? 22 : 2 }}
                            className="absolute top-1 w-3 h-3 bg-white rounded-full"
                          />
                        </button>
                      </div>

                      <div className="space-y-3">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-zinc-400">Motion Sensitivity</span>
                            <span className="text-[10px] font-mono text-emerald-500">{sensitivity}%</span>
                          </div>
                          <input 
                            type="range" 
                            min="1" 
                            max="99" 
                            value={sensitivity} 
                            onChange={(e) => setSensitivity(parseInt(e.target.value))}
                            className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                          />
                        </div>

                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-zinc-400">Audio Sensitivity</span>
                            <span className="text-[10px] font-mono text-emerald-500">{audioSensitivity}%</span>
                          </div>
                          <input 
                            type="range" 
                            min="1" 
                            max="99" 
                            value={audioSensitivity} 
                            onChange={(e) => setAudioSensitivity(parseInt(e.target.value))}
                            className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sidebar: Recent Events */}
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold flex items-center gap-2">
                    <History className="w-5 h-5 text-emerald-500" />
                    Recent Activity
                  </h2>
                  <button 
                    onClick={() => setActiveTab('history')}
                    className="text-[10px] uppercase font-bold tracking-widest text-zinc-500 hover:text-white transition-colors"
                  >
                    View All
                  </button>
                </div>

                <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                  {events.length === 0 ? (
                    <div className="py-12 text-center space-y-3 bg-zinc-900/30 rounded-3xl border border-dashed border-white/10">
                      <ShieldAlert className="w-8 h-8 text-zinc-700 mx-auto" />
                      <p className="text-sm text-zinc-500">No events detected yet</p>
                    </div>
                  ) : (
                    events.map((event) => (
                      <motion.div 
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        key={event.id}
                        className="group bg-zinc-900/80 rounded-2xl border border-white/5 overflow-hidden hover:border-emerald-500/30 transition-all"
                      >
                        <div className="aspect-video relative overflow-hidden">
                          <img src={event.image} alt="Event" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                          <div className="absolute top-3 left-3 px-2 py-1 bg-red-600 text-[8px] font-bold uppercase tracking-tighter rounded shadow-lg">
                            Suspicious
                          </div>
                        </div>
                        <div className="p-4 space-y-2">
                          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
                            <span>{event.timestamp.toLocaleTimeString()}</span>
                            <span>{event.timestamp.toLocaleDateString()}</span>
                          </div>
                          <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed italic">
                            "{event.reason}"
                          </p>
                        </div>
                      </motion.div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div 
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-black tracking-tighter uppercase italic">Security Archives</h2>
                  <p className="text-zinc-500 text-sm">Review all AI-flagged events and suspicious movements.</p>
                </div>
                <button 
                  onClick={() => setEvents([])}
                  className="px-4 py-2 bg-white/5 hover:bg-red-500/10 text-zinc-400 hover:text-red-500 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border border-white/10"
                >
                  Clear Logs
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {events.map((event) => (
                  <div key={event.id} className="bg-zinc-900 rounded-3xl border border-white/5 overflow-hidden hover:shadow-2xl transition-all">
                    <div className="aspect-video relative">
                      <img src={event.image} alt="Event" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                      <div className="absolute bottom-4 left-4">
                        <p className="text-[10px] font-mono text-emerald-500 font-bold uppercase tracking-widest">Event #{event.id}</p>
                        <h4 className="font-bold text-white">{event.timestamp.toLocaleString()}</h4>
                      </div>
                    </div>
                    <div className="p-6 space-y-4">
                      <div className="markdown-body text-sm text-zinc-400 leading-relaxed">
                        <Markdown>{event.reason}</Markdown>
                      </div>
                      <div className="pt-4 border-t border-white/5 flex items-center justify-between">
                        <button className="text-xs font-bold text-emerald-500 hover:underline">Download Frame</button>
                        <button className="text-xs font-bold text-zinc-500 hover:text-white">Report False Positive</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="mt-20 border-t border-white/5 py-12">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex items-center gap-3 opacity-50">
            <Shield className="w-5 h-5" />
            <span className="text-xs font-bold uppercase tracking-widest">SentryAI Protocol v4.0</span>
          </div>
          <div className="flex items-center gap-8 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
            <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
            <a href="#" className="hover:text-white transition-colors">API Documentation</a>
          </div>
          <p className="text-[10px] font-mono text-zinc-600">© 2026 SentryAI Security Systems. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
