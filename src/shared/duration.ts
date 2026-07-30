const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

interface DurationUnit {
  label: string;
  seconds: number;
}

const durationUnits: readonly DurationUnit[] = [
  {
    label: "day",
    seconds: HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE,
  },
  {
    label: "hour",
    seconds: MINUTES_PER_HOUR * SECONDS_PER_MINUTE,
  },
  { label: "minute", seconds: SECONDS_PER_MINUTE },
  { label: "second", seconds: 1 },
];

export function formatDurationMilliseconds(milliseconds: number): string {
  const totalSeconds = Math.max(
    1,
    Math.ceil(milliseconds / MILLISECONDS_PER_SECOND),
  );
  let remainingSeconds = totalSeconds;
  const parts: string[] = [];
  for (const unit of durationUnits) {
    const value = Math.floor(remainingSeconds / unit.seconds);
    if (value === 0) {
      continue;
    }
    const label = value === 1 ? unit.label : `${unit.label}s`;
    parts.push(`${value} ${label}`);
    remainingSeconds %= unit.seconds;
  }
  return parts.join(" ");
}
