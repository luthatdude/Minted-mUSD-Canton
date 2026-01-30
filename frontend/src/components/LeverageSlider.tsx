import { useState, useEffect } from 'react';

interface LeverageSliderProps {
  value: number; // 10-30 (1.0x - 3.0x)
  onChange: (value: number) => void;
  maxLeverage?: number; // Max allowed (default 30)
  disabled?: boolean;
}

const LEVERAGE_PRESETS = [
  { value: 10, label: '1x', description: 'No leverage' },
  { value: 15, label: '1.5x', description: 'Conservative' },
  { value: 20, label: '2x', description: 'Moderate' },
  { value: 25, label: '2.5x', description: 'Aggressive' },
  { value: 30, label: '3x', description: 'Maximum' },
];

export function LeverageSlider({ 
  value, 
  onChange, 
  maxLeverage = 30,
  disabled = false 
}: LeverageSliderProps) {
  const [sliderValue, setSliderValue] = useState(value);

  useEffect(() => {
    setSliderValue(value);
  }, [value]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(e.target.value);
    setSliderValue(newValue);
    onChange(newValue);
  };

  const handlePresetClick = (presetValue: number) => {
    if (presetValue <= maxLeverage && !disabled) {
      setSliderValue(presetValue);
      onChange(presetValue);
    }
  };

  const displayLeverage = (sliderValue / 10).toFixed(1);
  const riskLevel = sliderValue <= 15 ? 'low' : sliderValue <= 20 ? 'medium' : 'high';
  const riskColor = riskLevel === 'low' ? 'text-green-400' : riskLevel === 'medium' ? 'text-yellow-400' : 'text-red-400';
  const riskBgColor = riskLevel === 'low' ? 'bg-green-500' : riskLevel === 'medium' ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-white">Leverage</h3>
        <div className="flex items-center gap-2">
          <span className="text-3xl font-bold text-white">{displayLeverage}x</span>
          <span className={`text-sm ${riskColor} capitalize`}>({riskLevel} risk)</span>
        </div>
      </div>

      {/* Slider */}
      <div className="mb-6">
        <input
          type="range"
          min="10"
          max={maxLeverage}
          step="1"
          value={sliderValue}
          onChange={handleSliderChange}
          disabled={disabled}
          className={`w-full h-2 rounded-lg appearance-none cursor-pointer
            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
            bg-gradient-to-r from-green-500 via-yellow-500 to-red-500`}
          style={{
            background: `linear-gradient(to right, 
              #22c55e 0%, 
              #22c55e ${((15 - 10) / (maxLeverage - 10)) * 100}%, 
              #eab308 ${((20 - 10) / (maxLeverage - 10)) * 100}%, 
              #ef4444 100%)`
          }}
        />
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>1x</span>
          <span>1.5x</span>
          <span>2x</span>
          <span>2.5x</span>
          <span>3x</span>
        </div>
      </div>

      {/* Preset Buttons */}
      <div className="grid grid-cols-5 gap-2 mb-4">
        {LEVERAGE_PRESETS.map((preset) => (
          <button
            key={preset.value}
            onClick={() => handlePresetClick(preset.value)}
            disabled={disabled || preset.value > maxLeverage}
            className={`py-2 px-3 rounded-lg text-sm font-medium transition-all
              ${sliderValue === preset.value
                ? 'bg-blue-600 text-white ring-2 ring-blue-400'
                : preset.value > maxLeverage
                  ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }
              ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Risk Warning */}
      <div className={`p-3 rounded-lg ${
        riskLevel === 'low' ? 'bg-green-900/30 border border-green-800' :
        riskLevel === 'medium' ? 'bg-yellow-900/30 border border-yellow-800' :
        'bg-red-900/30 border border-red-800'
      }`}>
        <div className="flex items-start gap-2">
          <span className={`text-lg ${riskColor}`}>
            {riskLevel === 'low' ? '✓' : riskLevel === 'medium' ? '⚠' : '⚠'}
          </span>
          <div className="text-sm">
            <p className={riskColor}>
              {riskLevel === 'low' && 'Low liquidation risk. Safe for volatile markets.'}
              {riskLevel === 'medium' && 'Moderate risk. Monitor your position regularly.'}
              {riskLevel === 'high' && 'High liquidation risk! Small price moves can trigger liquidation.'}
            </p>
            {sliderValue > 20 && (
              <p className="text-gray-400 mt-1">
                Liquidation at ~{Math.round((1 - 1/((sliderValue/10) * 0.8)) * 100)}% price drop
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default LeverageSlider;
