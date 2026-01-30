import { useState } from 'react';
import { useWalletConnect } from '@/hooks/useWalletConnect';
import { useLoopWallet } from '@/hooks/useLoopWallet';

interface WalletConnectorProps {
  mode?: 'ethereum' | 'canton' | 'both';
  showBalance?: boolean;
  compact?: boolean;
}

export default function WalletConnector({ 
  mode = 'both',
  showBalance = true,
  compact = false,
}: WalletConnectorProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  
  const ethWallet = useWalletConnect();
  const loopWallet = useLoopWallet();

  // Format address for display
  const formatAddress = (addr: string) => 
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const handleEthConnect = async () => {
    try {
      await ethWallet.connect();
    } catch (err) {
      console.error('Failed to connect Ethereum wallet:', err);
    }
  };

  const handleCantonConnect = () => {
    loopWallet.connect();
  };

  // Check connection states
  const isEthConnected = ethWallet.isConnected && ethWallet.address;
  const isCantonConnected = loopWallet.isConnected && loopWallet.partyId;
  const anyConnected = isEthConnected || isCantonConnected;

  // Compact mode - just show connection status
  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {mode !== 'canton' && (
          <div className="flex items-center">
            {isEthConnected ? (
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/40 rounded-lg text-sm"
              >
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-emerald-300">
                  {ethWallet.ensName || formatAddress(ethWallet.address!)}
                </span>
              </button>
            ) : (
              <button
                onClick={handleEthConnect}
                disabled={ethWallet.isConnecting}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm transition-colors disabled:opacity-50"
              >
                {ethWallet.isConnecting ? 'Connecting...' : 'Connect ETH'}
              </button>
            )}
          </div>
        )}
        
        {mode !== 'ethereum' && (
          <div className="flex items-center">
            {isCantonConnected ? (
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 bg-purple-500/20 border border-purple-500/40 rounded-lg text-sm"
              >
                <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                <span className="text-purple-300 truncate max-w-[120px]">
                  {loopWallet.partyId}
                </span>
              </button>
            ) : (
              <button
                onClick={handleCantonConnect}
                disabled={loopWallet.isConnecting}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-sm transition-colors disabled:opacity-50"
              >
                {loopWallet.isConnecting ? 'Connecting...' : 'Connect Canton'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // Full mode - expandable panel
  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
      <h3 className="text-lg font-semibold text-white mb-4">Wallet Connection</h3>
      
      <div className="space-y-4">
        {/* Ethereum Wallet */}
        {mode !== 'canton' && (
          <div className="bg-slate-700/40 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-blue-500/20 rounded-full flex items-center justify-center">
                  <svg className="w-5 h-5 text-blue-400" fill="currentColor" viewBox="0 0 320 512">
                    <path d="M311.9 260.8L160 353.6 8 260.8 160 0l151.9 260.8zM160 383.4L8 290.6 160 512l152-221.4-152 92.8z"/>
                  </svg>
                </div>
                <div>
                  <div className="text-white font-medium">Ethereum</div>
                  <div className="text-xs text-slate-400">
                    {ethWallet.chain?.name || 'Not connected'}
                  </div>
                </div>
              </div>
              
              {isEthConnected ? (
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-emerald-300 text-sm">Connected</span>
                </div>
              ) : (
                <span className="text-slate-400 text-sm">Disconnected</span>
              )}
            </div>
            
            {isEthConnected ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-400">Address</span>
                  <span className="text-white font-mono">
                    {ethWallet.ensName || formatAddress(ethWallet.address!)}
                  </span>
                </div>
                {showBalance && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Balance</span>
                    <span className="text-white">
                      {parseFloat(ethWallet.ethBalance).toFixed(4)} ETH
                    </span>
                  </div>
                )}
                <button
                  onClick={ethWallet.disconnect}
                  className="w-full mt-2 px-4 py-2 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 text-red-400 rounded-lg text-sm transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={handleEthConnect}
                disabled={ethWallet.isConnecting}
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {ethWallet.isConnecting ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Connecting...
                  </span>
                ) : (
                  'Connect MetaMask'
                )}
              </button>
            )}
            
            {ethWallet.error && (
              <p className="mt-2 text-xs text-red-400">{ethWallet.error}</p>
            )}
          </div>
        )}
        
        {/* Canton Wallet (Loop) */}
        {mode !== 'ethereum' && (
          <div className="bg-slate-700/40 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-purple-500/20 rounded-full flex items-center justify-center">
                  <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <div>
                  <div className="text-white font-medium">Canton Network</div>
                  <div className="text-xs text-slate-400">
                    {isCantonConnected ? 'Loop Wallet' : 'Not connected'}
                  </div>
                </div>
              </div>
              
              {isCantonConnected ? (
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                  <span className="text-purple-300 text-sm">Connected</span>
                </div>
              ) : (
                <span className="text-slate-400 text-sm">Disconnected</span>
              )}
            </div>
            
            {isCantonConnected ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-400">Party ID</span>
                  <span className="text-white font-mono text-xs truncate max-w-[180px]">
                    {loopWallet.partyId}
                  </span>
                </div>
                {loopWallet.email && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Email</span>
                    <span className="text-white">{loopWallet.email}</span>
                  </div>
                )}
                {showBalance && loopWallet.holdings.length > 0 && (
                  <div className="mt-2 p-2 bg-slate-800/50 rounded">
                    <div className="text-xs text-slate-400 mb-1">Holdings</div>
                    {loopWallet.holdings.slice(0, 3).map((h, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="text-slate-300">{h.symbol}</span>
                        <span className="text-white">
                          {(Number(h.total_unlocked_coin) / Math.pow(10, h.decimals)).toFixed(4)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  onClick={loopWallet.disconnect}
                  className="w-full mt-2 px-4 py-2 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 text-red-400 rounded-lg text-sm transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={handleCantonConnect}
                disabled={loopWallet.isConnecting}
                className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {loopWallet.isConnecting ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Connecting...
                  </span>
                ) : (
                  'Connect Loop Wallet'
                )}
              </button>
            )}
            
            {loopWallet.error && (
              <p className="mt-2 text-xs text-red-400">{loopWallet.error}</p>
            )}
          </div>
        )}
      </div>
      
      {/* Connection status summary */}
      {mode === 'both' && anyConnected && (
        <div className="mt-4 pt-4 border-t border-slate-700">
          <div className="flex items-center gap-4 text-sm">
            <span className="text-slate-400">Status:</span>
            {isEthConnected && isCantonConnected ? (
              <span className="text-emerald-400">✓ Both networks connected</span>
            ) : isEthConnected ? (
              <span className="text-yellow-400">Ethereum only</span>
            ) : (
              <span className="text-yellow-400">Canton only</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
