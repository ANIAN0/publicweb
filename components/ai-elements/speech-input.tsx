"use client";

// SpeechInput：自动检测浏览器能力后委托给 SpeechRecognitionInput 或 MediaRecorderInput。
// 这是"门面"组件，目的是保持历史 API。
// 推荐：新代码显式使用 supportsSpeechRecognition()/supportsMediaRecorder() 自行分支，
// 或直接引入 SpeechRecognitionInput / MediaRecorderInput。

import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";

import {
  MediaRecorderInput,
  supportsMediaRecorder,
} from "./media-recorder-input";
import {
  SpeechRecognitionInput,
  supportsSpeechRecognition,
} from "./speech-recognition-input";

type SpeechInputMode = "speech-recognition" | "media-recorder" | "none";

export type SpeechInputProps = ComponentProps<
  typeof SpeechRecognitionInput
> & {
  /** MediaRecorder 回退：浏览器不支持 Web Speech API 时，调用方负责转写音频 Blob */
  onAudioRecorded?: (audioBlob: Blob) => Promise<string>;
};

export const SpeechInput = ({
  onAudioRecorded,
  className,
  ...props
}: SpeechInputProps) => {
  const [mode, setMode] = useState<SpeechInputMode>("none");

  useEffect(() => {
    if (supportsSpeechRecognition()) {
      setMode("speech-recognition");
    } else if (supportsMediaRecorder()) {
      setMode("media-recorder");
    } else {
      setMode("none");
    }
  }, []);

  // 装饰层：脉冲环（auto-detect 模式下保留视觉反馈，与历史行为一致）
  if (mode === "speech-recognition") {
    return (
      <SpeechRecognitionInput className={cn(className)} {...props} />
    );
  }

  if (mode === "media-recorder") {
    if (!onAudioRecorded) return null;
    return (
      <MediaRecorderInput
        className={cn(className)}
        onAudioRecorded={onAudioRecorded}
        {...props}
      />
    );
  }

  return null;
};

export {
  MediaRecorderInput,
  SpeechRecognitionInput,
  supportsMediaRecorder,
  supportsSpeechRecognition,
};