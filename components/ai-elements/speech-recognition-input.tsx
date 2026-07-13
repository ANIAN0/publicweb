"use client";

// SpeechRecognitionInput：使用 Web Speech API（Chromium 系浏览器）
// 这是显式变体之一。调用方按浏览器能力选择 SpeechRecognitionInput 或 MediaRecorderInput。
// 也可继续使用 SpeechInput 自动检测（向后兼容）。

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MicIcon, SquareIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

export type SpeechRecognitionInputProps = ComponentProps<typeof Button> & {
  onTranscriptionChange?: (text: string) => void;
  lang?: string;
};

export const SpeechRecognitionInput = ({
  className,
  onTranscriptionChange,
  lang = "en-US",
  ...props
}: SpeechRecognitionInputProps) => {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const onTranscriptionChangeRef = useRef<
    SpeechRecognitionInputProps["onTranscriptionChange"]
  >(onTranscriptionChange);
  onTranscriptionChangeRef.current = onTranscriptionChange;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    const handleResult = (event: Event) => {
      const speechEvent = event as SpeechRecognitionEvent;
      let finalTranscript = "";
      for (
        let i = speechEvent.resultIndex;
        i < speechEvent.results.length;
        i += 1
      ) {
        const result = speechEvent.results[i];
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? "";
        }
      }
      if (finalTranscript) {
        onTranscriptionChangeRef.current?.(finalTranscript);
      }
    };

    const handleStart = () => setIsListening(true);
    const handleEnd = () => setIsListening(false);
    const handleError = () => setIsListening(false);

    recognition.addEventListener("result", handleResult);
    recognition.addEventListener("start", handleStart);
    recognition.addEventListener("end", handleEnd);
    recognition.addEventListener("error", handleError);
    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
      recognition.removeEventListener("result", handleResult);
      recognition.removeEventListener("start", handleStart);
      recognition.removeEventListener("end", handleEnd);
      recognition.removeEventListener("error", handleError);
      recognitionRef.current = null;
    };
  }, [lang]);

  const toggleListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (isListening) {
      recognition.stop();
    } else {
      recognition.start();
    }
  }, [isListening]);

  return (
    <Button
      aria-label={isListening ? "Stop recording" : "Start recording"}
      className={cn(
        "rounded-full transition-all duration-300",
        isListening
          ? "bg-destructive text-white hover:bg-destructive/80 hover:text-white"
          : "bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground",
        className,
      )}
      onClick={toggleListening}
      type="button"
      {...props}
    >
      {isListening ? <SquareIcon className="size-4" /> : <MicIcon className="size-4" />}
    </Button>
  );
};

/** 检测当前环境是否支持 Web Speech API */
export const supportsSpeechRecognition = (): boolean =>
  typeof window !== "undefined" &&
  ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
