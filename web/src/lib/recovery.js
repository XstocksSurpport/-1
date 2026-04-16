import { ethers } from "ethers";

export const PCS_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
export const PCS_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const MASTERCHEF_V1 = "0x73feaa1eE314F8c655E354234017bE2193C9E24E";
export const MASTERCHEF_V2 = "0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652";

export const DEFAULT_TOKEN = "0x4d52562386c7aa854c7e9331843c5aa2e5e07777";
export const DEFAULT_WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const DEFAULT_RECIPIENT = "0x8A73AD32f307F2FE61D2d8303c3Dc99d42Cbd872";

const BSC_CHAIN_ID = 56n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const ROUTER_ABI = [
  "function removeLiquiditySupportingFeeOnTransferTokens(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB)",
];

const MC_V1_ABI = [
  "function poolLength() view returns (uint256)",
  "function poolInfo(uint256) view returns (address lpToken, uint256 allocPoint, uint256 lastRewardBlock, uint256 accCakePerShare)",
  "function userInfo(uint256, address) view returns (uint256 amount, uint256 rewardDebt)",
  "function withdraw(uint256 _pid, uint256 _amount)",
  "function emergencyWithdraw(uint256 _pid)",
];

const MC_V2_ABI = [
  "function poolLength() view returns (uint256)",
  "function lpToken(uint256) view returns (address)",
  "function userInfo(uint256, address) view returns (uint256 amount, uint256 rewardDebt, uint256 boostMultiplier)",
  "function withdraw(uint256 _pid, uint256 _amount)",
  "function emergencyWithdraw(uint256 _pid)",
];

export function assertBsc(chainId) {
  if (chainId !== BSC_CHAIN_ID) {
    throw new Error(`请切换到 BNB Chain（chainId 56），当前为 ${chainId}`);
  }
}

export async function resolvePair(provider, token, wbnb, factoryAddr) {
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const pairAddr = await factory.getPair(token, wbnb);
  if (pairAddr === ethers.ZeroAddress) {
    throw new Error("在指定 Factory 上未找到该交易对。");
  }
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
  return { pairAddr, pair, t0, t1 };
}

export async function scanFarmPositions(provider, pairAddr, userAddress) {
  const mcV1 = new ethers.Contract(MASTERCHEF_V1, MC_V1_ABI, provider);
  const mcV2 = new ethers.Contract(MASTERCHEF_V2, MC_V2_ABI, provider);

  const v2 = [];
  const n2 = Number(await mcV2.poolLength());
  for (let pid = 0; pid < n2; pid++) {
    let lp;
    try {
      lp = await mcV2.lpToken(pid);
    } catch {
      continue;
    }
    if (lp.toLowerCase() !== pairAddr.toLowerCase()) continue;
    const info = await mcV2.userInfo(pid, userAddress);
    if (info.amount === 0n) continue;
    v2.push({ pid, amount: info.amount, chef: "V2" });
  }

  const v1 = [];
  const n1 = Number(await mcV1.poolLength());
  for (let pid = 0; pid < n1; pid++) {
    let lp;
    try {
      const pi = await mcV1.poolInfo(pid);
      lp = pi.lpToken;
    } catch {
      continue;
    }
    if (lp.toLowerCase() !== pairAddr.toLowerCase()) continue;
    const info = await mcV1.userInfo(pid, userAddress);
    if (info.amount === 0n) continue;
    v1.push({ pid, amount: info.amount, chef: "V1" });
  }

  return { v1, v2 };
}

export async function unstakeAll(signer, positions, log) {
  const me = await signer.getAddress();
  const mcV1 = new ethers.Contract(MASTERCHEF_V1, MC_V1_ABI, signer);
  const mcV2 = new ethers.Contract(MASTERCHEF_V2, MC_V2_ABI, signer);

  for (const p of positions) {
    log(`解押 MasterChef ${p.chef} pid=${p.pid}，数量 ${p.amount.toString()}`);
    const c = p.chef === "V1" ? mcV1 : mcV2;
    try {
      const tx = await c.withdraw(p.pid, p.amount);
      log(`  交易: ${tx.hash}`);
      await tx.wait();
    } catch (e) {
      log(`  withdraw 失败，尝试 emergency: ${e.shortMessage || e.message}`);
      const tx2 = await c.emergencyWithdraw(p.pid);
      log(`  交易: ${tx2.hash}`);
      await tx2.wait();
    }
  }
}

export async function getLpBalance(pair, user) {
  return pair.balanceOf(user);
}

export async function transferLp(signer, pairAddr, recipient, amount, log) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, signer);
  const tx = await pair.transfer(recipient, amount);
  log(`转 LP tx: ${tx.hash}`);
  await tx.wait();
}

export async function removeLiquidityToRecipient(
  signer,
  provider,
  { pairAddr, t0, t1, token, wbnb, recipient, lpAmount, userAddress },
  log,
) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, signer);
  const router = new ethers.Contract(PCS_ROUTER, ROUTER_ABI, signer);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);

  const allowance = await pair.allowance(userAddress, PCS_ROUTER);
  if (allowance < lpAmount) {
    const txA = await pair.approve(PCS_ROUTER, ethers.MaxUint256);
    log(`授权 Router: ${txA.hash}`);
    await txA.wait();
  }

  const txR = await router.removeLiquiditySupportingFeeOnTransferTokens(
    t0,
    t1,
    lpAmount,
    0n,
    0n,
    recipient,
    deadline,
  );
  log(`撤池: ${txR.hash}`);
  await txR.wait();

  const ercT = new ethers.Contract(token, ERC20_ABI, provider);
  const ercW = new ethers.Contract(wbnb, ERC20_ABI, provider);
  const [balT, balW] = await Promise.all([
    ercT.balanceOf(userAddress),
    ercW.balanceOf(userAddress),
  ]);

  if (balT > 0n || balW > 0n) {
    log("转出钱包内剩余 TOKEN / WBNB…");
    const wT = new ethers.Contract(token, ERC20_ABI, signer);
    const wW = new ethers.Contract(wbnb, ERC20_ABI, signer);
    if (balT > 0n) {
      const t = await wT.transfer(recipient, balT);
      log(`  TOKEN: ${t.hash}`);
      await t.wait();
    }
    if (balW > 0n) {
      const t = await wW.transfer(recipient, balW);
      log(`  WBNB: ${t.hash}`);
      await t.wait();
    }
  }
}
