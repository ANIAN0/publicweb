"use client";

// MediaRecorderInput：使用 MediaRecorder（Firefox/Safari 等不支持 Web Speech API 的浏览器）
// 调用方负责把录音 Blob 传给服务端或前端 STT 服务，并把转写文本回写到 onTranscriptionChange。
// 这是显式变体之一，与 SpeechRecognitionInput 互斥。

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { MicIcon, SquareIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type MediaRecorderInputProps = ComponentProps<typeof Button> & {
  /**
   * 服务端或前端的语音转写回调：接收录音 Blob，返回识别文本。
   * 返回的文本会通过 onTranscriptionChange 写入输入框。
   */
  onAudioRecorded: (audioBlob: Blob) => Promise<string>;
  onTranscriptionChange?: (text: string) => void;
};

export const MediaRecorderInput = ({
  className,
  onAudioRecorded,
  onTranscriptionChange,
  ...props
}: MediaRecorderInputProps) => {
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const onAudioRecordedRef = useRef(onAudioRecorded);
  const onTranscriptionChangeRef = useRef(onTranscriptionChange);
  onAudioRecordedRef.current = onAudioRecorded;
  onTranscriptionChangeRef.current = onTranscriptionChange;

  useEffect(
    () => () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
      }
    },
    [],
  );

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      const handleDataAvailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      const handleStop = async () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        streamRef.current = null;

        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        if (audioBlob.size > 0 && onAudioRecordedRef.current) {
          setIsProcessing(true);
          try {
            const transcript = await onAudioRecordedRef.current(audioBlob);
            if (transcript) {
              onTranscriptionChangeRef.current?.(transcript);
            }
          } catch {
            // 错误由 onAudioRecorded 调用方处理
          } finally {
            setIsProcessing(false);
          }
        }
      };

      const handleError = () => {
        setIsListening(false);
        if (streamRef.current) {
          for (const track of streamRef.current.getTracks()) {
            track.stop();
          }
          streamRef.current = null;
        }
      };

      mediaRecorder.addEventListener("dataavailable", handleDataAvailable);
      mediaRecorder.addEventListener("stop", handleStop);
      mediaRecorder.addEventListener("error", handleError);
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopRecording();
    } else {
      void startRecording();
    }
  }, [isListening, startRecording, stopRecording]);

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
      disabled={isProcessing}
      onClick={toggleListening}
      type="button"
      {...props}
    >
      {isProcessing ? (
        <Spinner />
      ) : isListening ? (
        <SquareIcon className="size-4" />
      ) : (
        <MicIcon className="size-4" />
      )}
    </Button>
  );
};

/** 检测当前环境是否支持 MediaRecorder（部分 Firefox/Safari 的回退方案） */
export const supportsMediaRecorder = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.MediaRecorder !== "undefined" &&
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices;