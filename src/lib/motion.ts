import type { Transition, Variants } from 'motion/react';

const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const EASE_IN = [0.4, 0, 1, 1] as const;

export function motionTransition(
  shouldReduceMotion: boolean,
  duration: number,
  delay = 0,
): Transition {
  return {
    duration: shouldReduceMotion ? 0 : duration,
    delay: shouldReduceMotion ? 0 : delay,
    ease: EASE_OUT,
  };
}

export function pageVariants(shouldReduceMotion: boolean): Variants {
  return {
    initial: { opacity: 0, y: shouldReduceMotion ? 0 : 16 },
    animate: {
      opacity: 1,
      y: 0,
      transition: motionTransition(shouldReduceMotion, 0.36),
    },
    exit: {
      opacity: 0,
      y: shouldReduceMotion ? 0 : -8,
      transition: { ...motionTransition(shouldReduceMotion, 0.2), ease: EASE_IN },
    },
  };
}

export function staggerContainerVariants(shouldReduceMotion: boolean): Variants {
  return {
    hidden: { opacity: 1 },
    visible: {
      opacity: 1,
      transition: {
        delayChildren: shouldReduceMotion ? 0 : 0.05,
        staggerChildren: shouldReduceMotion ? 0 : 0.06,
      },
    },
  };
}

export function staggerItemVariants(shouldReduceMotion: boolean): Variants {
  return {
    hidden: { opacity: 0, y: shouldReduceMotion ? 0 : 14 },
    visible: {
      opacity: 1,
      y: 0,
      transition: motionTransition(shouldReduceMotion, 0.3),
    },
  };
}

export function fadeScaleVariants(shouldReduceMotion: boolean): Variants {
  return {
    initial: { opacity: 0, scale: shouldReduceMotion ? 1 : 0.98 },
    animate: {
      opacity: 1,
      scale: 1,
      transition: motionTransition(shouldReduceMotion, 0.24),
    },
    exit: {
      opacity: 0,
      scale: shouldReduceMotion ? 1 : 0.98,
      transition: { ...motionTransition(shouldReduceMotion, 0.18), ease: EASE_IN },
    },
  };
}

export function expandVariants(shouldReduceMotion: boolean): Variants {
  return {
    initial: { opacity: 0, height: 0, y: shouldReduceMotion ? 0 : -4 },
    animate: {
      opacity: 1,
      height: 'auto',
      y: 0,
      transition: motionTransition(shouldReduceMotion, 0.24),
    },
    exit: {
      opacity: 0,
      height: 0,
      y: shouldReduceMotion ? 0 : -4,
      transition: { ...motionTransition(shouldReduceMotion, 0.18), ease: EASE_IN },
    },
  };
}

export function modalBackdropVariants(shouldReduceMotion: boolean): Variants {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: motionTransition(shouldReduceMotion, 0.2) },
    exit: { opacity: 0, transition: { ...motionTransition(shouldReduceMotion, 0.16), ease: EASE_IN } },
  };
}

export function modalPanelVariants(shouldReduceMotion: boolean): Variants {
  return {
    initial: { opacity: 0, y: shouldReduceMotion ? 0 : 12, scale: shouldReduceMotion ? 1 : 0.96 },
    animate: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: motionTransition(shouldReduceMotion, 0.24),
    },
    exit: {
      opacity: 0,
      y: shouldReduceMotion ? 0 : 8,
      scale: shouldReduceMotion ? 1 : 0.98,
      transition: { ...motionTransition(shouldReduceMotion, 0.18), ease: EASE_IN },
    },
  };
}

export function toastVariants(shouldReduceMotion: boolean): Variants {
  return {
    initial: { opacity: 0, x: shouldReduceMotion ? 0 : 24, scale: shouldReduceMotion ? 1 : 0.96 },
    animate: {
      opacity: 1,
      x: 0,
      scale: 1,
      transition: motionTransition(shouldReduceMotion, 0.24),
    },
    exit: {
      opacity: 0,
      x: shouldReduceMotion ? 0 : 24,
      scale: shouldReduceMotion ? 1 : 0.96,
      transition: { ...motionTransition(shouldReduceMotion, 0.18), ease: EASE_IN },
    },
  };
}
