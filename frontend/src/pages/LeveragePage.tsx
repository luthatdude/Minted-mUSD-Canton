import { useState, useEffect } from 'react';
import { ethers, Contract } from 'ethers';
import LeverageSlider from '../components/LeverageSlider';
import { TxButton } from '../components/TxButton';
import { StatCard } from '../components/StatCard';
import WalletConnector from '../components/WalletConnector';
import { useWalletConnect } from '../hooks/useWalletConnect';
import { LeverageVaultABI } from '../abis/LeverageVault';
import { ERC20_ABI } from '../abis/ERC20';
import { formatUSD, formatToken } from '../lib/format';

// Contract addresses - update for your deployment
const LEVERAGE_VAULT_ADDRESS = process.env.NEXT_PUBLIC_LEVERAGE_VAULT_ADDRESS || '';
const WETH_ADDRESS = process.env.NEXT_PUBLIC_WETH_ADDRESS || '';

interface Position {
  collateralToken: string;
  initialDeposit: bigint;
  totalCollateral: bigint;
  totalDebt: bigint;
  loopsExecuted: bigint;
  targetLeverageX10: bigint;
  openedAt: bigint;
}

export default function LeveragePage() {
  const { address, isConnected, signer, provider, getContract } = useWalletConnect();
  
  // Contracts
  const [leverageVault, setLeverageVault] = useState<Contract | null>(null);
  const [weth, setWeth] = useState<Contract | null>(null);

  // Initialize contracts when signer is available
  useEffect(() => {
    if (signer && LEVERAGE_VAULT_ADDRESS && WETH_ADDRESS) {
      setLeverageVault(new Contract(LEVERAGE_VAULT_ADDRESS, LeverageVaultABI, signer));
      setWeth(new Contract(WETH_ADDRESS, ERC20_ABI, signer));
    }
  }, [signer]);

  // Form state
  const [depositAmount, setDepositAmount] = useState('');
  const [leverageX10, setLeverageX10] = useState(20); // Default 2x
  const [maxLoops, setMaxLoops] = useState(5);

  // Position state
  const [position, setPosition] = useState<Position | null>(null);
  const [hasPosition, setHasPosition] = useState(false);

  // UI state
  const [wethBalance, setWethBalance] = useState<bigint>(0n);
  const [wethAllowance, setWethAllowance] = useState<bigint>(0n);
  const [estimatedLoops, setEstimatedLoops] = useState(0);
  const [estimatedDebt, setEstimatedDebt] = useState<bigint>(0n);
  const [maxLeverage, setMaxLeverage] = useState(30);
  const [loading, setLoading] = useState(false);

  // Fetch user data
  useEffect(() => {
    async function fetchData() {
      if (!leverageVault || !weth || !address) return;

      try {
        // Get WETH balance and allowance
        const balance = await weth.balanceOf(address);
        const allowance = await weth.allowance(address, LEVERAGE_VAULT_ADDRESS);
        setWethBalance(balance);
        setWethAllowance(allowance);

        // Get current position
        const pos = await leverageVault.getPosition(address);
        if (pos.totalCollateral > 0n) {
          setPosition(pos);
          setHasPosition(true);
        } else {
          setPosition(null);
          setHasPosition(false);
        }

        // Get max leverage setting
        const maxLev = await leverageVault.maxLeverageX10();
        setMaxLeverage(Number(maxLev));
      } catch (err) {
        console.error('Error fetching data:', err);
      }
    }

    fetchData();
  }, [leverageVault, weth, address]);

  // Estimate loops when inputs change
  useEffect(() => {
    async function estimate() {
      if (!leverageVault || !depositAmount || parseFloat(depositAmount) <= 0) {
        setEstimatedLoops(0);
        setEstimatedDebt(0n);
        return;
      }

      try {
        const amount = ethers.parseEther(depositAmount);
        const [loops, debt] = await leverageVault.estimateLoops(WETH_ADDRESS, amount, leverageX10);
        setEstimatedLoops(Number(loops));
        setEstimatedDebt(debt);
      } catch (err) {
        console.error('Estimate error:', err);
      }
    }

    estimate();
  }, [leverageVault, depositAmount, leverageX10]);

  // FIX M-03/M-04: Combined atomic approve + open position
  // Previously used separate MaxUint256 approve then open (two clicks, race condition)
  const handleOpenPosition = async () => {
    if (!leverageVault || !weth || !depositAmount) return;
    setLoading(true);
    try {
      const amount = ethers.parseEther(depositAmount);
      // Check allowance and approve exact amount if needed (atomic pattern)
      const currentAllowance = await weth.allowance(address, LEVERAGE_VAULT_ADDRESS);
      if (currentAllowance < amount) {
        const approveTx = await weth.approve(LEVERAGE_VAULT_ADDRESS, amount);
        await approveTx.wait();
        setWethAllowance(amount);
      }
      const tx = await leverageVault.openLeveragedPosition(
        WETH_ADDRESS,
        amount,
        leverageX10,
        maxLoops
      );
      await tx.wait();
      // Refresh position
      const pos = await leverageVault.getPosition(address);
      setPosition(pos);
      setHasPosition(true);
      setDepositAmount('');
    } catch (err) {
      console.error('Open position error:', err);
    }
    setLoading(false);
  };

  // Close position
  const handleClosePosition = async () => {
    if (!leverageVault || !position) return;
    setLoading(true);
    try {
      // FIX FE-H03: Calculate reasonable minCollateralOut instead of 0
      // Use 95% of initial deposit as minimum to protect against sandwich/MEV attacks
      const minOut = (position.initialDeposit * 95n) / 100n;
      const tx = await leverageVault.closeLeveragedPosition(minOut);
      await tx.wait();
      setPosition(null);
      setHasPosition(false);
    } catch (err) {
      console.error('Close position error:', err);
    }
    setLoading(false);
  };

  const effectiveLeverage = position 
    ? (Number(position.totalCollateral) / Number(position.initialDeposit)).toFixed(2)
    : '0';

  // Not connected - show wallet connector
  if (!isConnected) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="text-3xl font-bold text-white mb-2">Leverage Vault</h1>
        <p className="text-gray-400 mb-8">
          Open leveraged positions with automatic looping via Uniswap V3
        </p>
        
        <div className="max-w-md mx-auto">
          <WalletConnector mode="ethereum" />
        </div>
        
        <div className="text-center text-gray-400 py-8">
          Connect your wallet to use Ethereum leverage
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Wallet status bar */}
      <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">Leverage Vault</h1>
            <p className="text-gray-400">
              Open leveraged positions with automatic looping via Uniswap V3
            </p>
          </div>
          <WalletConnector mode="ethereum" compact />
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatCard 
            label="WETH Balance" 
            value={formatToken(wethBalance, 18, 4)} 
            subValue="WETH"
          />
          <StatCard 
            label="Max Leverage" 
            value={`${(maxLeverage / 10).toFixed(1)}x`}
          />
          <StatCard 
            label="Your Position" 
            value={hasPosition ? `${effectiveLeverage}x` : 'None'}
          />
          <StatCard 
            label="Your Debt" 
            value={position ? formatToken(position.totalDebt, 18, 2) : '0'}
            subValue="mUSD"
          />
        </div>

        {!hasPosition ? (
          /* Open Position Form */
          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
            <h2 className="text-xl font-semibold text-white mb-6">Open Leveraged Position</h2>

            {/* Deposit Amount */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-400 mb-2">
                Deposit Amount
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.0"
                  className="w-full bg-gray-800 text-white text-2xl font-medium rounded-xl 
                    px-4 py-4 pr-24 border border-gray-700 focus:border-blue-500 
                    focus:ring-1 focus:ring-blue-500 outline-none"
                />
                <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                  <button
                    onClick={() => setDepositAmount(ethers.formatEther(wethBalance))}
                    className="text-sm text-blue-400 hover:text-blue-300"
                  >
                    MAX
                  </button>
                  <span className="text-gray-400">WETH</span>
                </div>
              </div>
            </div>

            {/* Leverage Slider */}
            <div className="mb-6">
              <LeverageSlider
                value={leverageX10}
                onChange={setLeverageX10}
                maxLeverage={maxLeverage}
                disabled={loading}
              />
            </div>

            {/* Estimated Output */}
            {depositAmount && parseFloat(depositAmount) > 0 && (
              <div className="bg-gray-800 rounded-xl p-4 mb-6">
                <h4 className="text-sm font-medium text-gray-400 mb-3">Position Preview</h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Total Collateral:</span>
                    <span className="text-white ml-2">
                      ~{(parseFloat(depositAmount) * leverageX10 / 10).toFixed(4)} WETH
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Estimated Debt:</span>
                    <span className="text-white ml-2">
                      ~{formatToken(estimatedDebt, 18, 2)} mUSD
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Loop Iterations:</span>
                    <span className="text-white ml-2">{estimatedLoops}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Effective Leverage:</span>
                    <span className="text-white ml-2">{(leverageX10 / 10).toFixed(1)}x</span>
                  </div>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-4">
              <TxButton
                onClick={handleOpenPosition}
                loading={loading}
                disabled={!isConnected || !depositAmount || parseFloat(depositAmount) <= 0}
                className="flex-1"
              >
                Open {(leverageX10 / 10).toFixed(1)}x Position
              </TxButton>
            </div>
          </div>
        ) : (
          /* Current Position */
          <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
            <h2 className="text-xl font-semibold text-white mb-6">Your Position</h2>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-6">
              <div className="bg-gray-800 rounded-xl p-4">
                <p className="text-sm text-gray-400">Initial Deposit</p>
                <p className="text-xl font-bold text-white">
                  {formatToken(position!.initialDeposit, 18, 4)} WETH
                </p>
              </div>
              <div className="bg-gray-800 rounded-xl p-4">
                <p className="text-sm text-gray-400">Total Collateral</p>
                <p className="text-xl font-bold text-white">
                  {formatToken(position!.totalCollateral, 18, 4)} WETH
                </p>
              </div>
              <div className="bg-gray-800 rounded-xl p-4">
                <p className="text-sm text-gray-400">Debt Owed</p>
                <p className="text-xl font-bold text-white">
                  {formatToken(position!.totalDebt, 18, 2)} mUSD
                </p>
              </div>
              <div className="bg-gray-800 rounded-xl p-4">
                <p className="text-sm text-gray-400">Effective Leverage</p>
                <p className="text-xl font-bold text-blue-400">
                  {effectiveLeverage}x
                </p>
              </div>
              <div className="bg-gray-800 rounded-xl p-4">
                <p className="text-sm text-gray-400">Loops Executed</p>
                <p className="text-xl font-bold text-white">
                  {position!.loopsExecuted.toString()}
                </p>
              </div>
              <div className="bg-gray-800 rounded-xl p-4">
                <p className="text-sm text-gray-400">Opened</p>
                <p className="text-xl font-bold text-white">
                  {new Date(Number(position!.openedAt) * 1000).toLocaleDateString()}
                </p>
              </div>
            </div>

            <TxButton
              onClick={handleClosePosition}
              loading={loading}
              variant="danger"
              className="w-full"
            >
              Close Position & Repay Debt
            </TxButton>
          </div>
        )}
      </div>
  );
}
