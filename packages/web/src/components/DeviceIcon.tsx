const ICONS: Record<string, string> = {
  fridge: '🧊',
  ac: '❄️',
  dryer: '🌀',
  washer: '🫧',
  stove: '🔥',
  oven: '🔥',
  car: '🚗',
  alwayson: '🔌',
  home: '🏠',
  heat: '🌡️',
  lightbulb: '💡',
  light: '💡',
  microwave: '📡',
  dishwasher: '🍽️',
  pump: '💧',
  fan: '🌬️',
  tv: '📺',
  computer: '💻',
  garage: '🚪',
  toaster: '🍞',
  kettle: '☕',
};

export function DeviceIcon({ icon, className }: { icon: string | null; className?: string }) {
  const glyph = (icon && ICONS[icon.toLowerCase()]) || '⚡';
  return (
    <span role="img" aria-hidden className={className}>
      {glyph}
    </span>
  );
}
