/**
 * BNB Chain：从 PancakeSwap V2 农场取回指定币对 LP，并转移到目标地址。
 *
 * 用法（PowerShell）：
 *   1. 复制 .env.example 为 .env，填入 PRIVATE_KEY（不要带 0x 或带 0x 均可）
 *   2. npm install
 *   npm run recover
 *
 * 环境变量：
 *   PRIVATE_KEY        必填，用于签名的钱包私钥
 *   RPC_URL            可选，默认 https://bsc-dataseed.binance.org/
 *   RECIPIENT          可选，默认下面 DEFAULT_RECIPIENT
 *   TOKEN              可选，默认屎壳郎合约
 *   WBNB               可选，默认主网 WBNB
 *   PCS_FACTORY        可选，默认 Pancake V2 Factory
 *   LP_PAIR            可选，若设置则直接按该 LP 合约地址扫描（忽略 TOKEN/WBNB/PCS_FACTORY）
 *   REMOVE_LIQUIDITY   可选，true=撤池后把两种 token 转给 RECIPIENT；false=只转 LP 凭证
 *   DRY_RUN            可选，true=只查询不写链
 *
 * 安全：私钥只放 .env，勿提交仓库；在干净机器上运行。
 */

import "dotenv/config";
import { ethers } from "ethers";

// ---------- 你提供的常量（可用环境变量覆盖） ----------
const DEFAULT_TOKEN = "0x4d52562386c7aa854c7e9331843c5aa2e5e07777";
const DEFAULT_WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const DEFAULT_RECIPIENT = "0x8A73AD32f307F2FE61D2d8303c3Dc99d42Cbd872";

const PCS_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const PCS_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const MASTERCHEF_V1 = "0x73feaa1eE314F8c655E354234017bE2193C9E24E";
const MASTERCHEF_V2 = "0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
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

function envBool(name, defaultVal = false) {
  const v = process.env[name];
  if (v == null || v === "") return defaultVal;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("缺少 PRIVATE_KEY，请在 .env 中设置。");
    process.exit(1);
  }

  const rpc =
    process.env.RPC_URL || "https://bsc-dataseed.binance.org/";
  const recipient = ethers.getAddress(
    process.env.RECIPIENT || DEFAULT_RECIPIENT,
  );
  const lpPairEnv = process.env.LP_PAIR?.trim();
  const removeLiquidity = envBool("REMOVE_LIQUIDITY", true);
  const dryRun = envBool("DRY_RUN", false);

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  const me = wallet.address;

  let token;
  let wbnb;
  let pairAddr;
  let pair;

  if (lpPairEnv) {
    pairAddr = ethers.getAddress(lpPairEnv);
    pair = new ethers.Contract(pairAddr, PAIR_ABI, wallet);
    console.log("模式: 直接 LP 合约 LP_PAIR=", pairAddr);
  } else {
    token = ethers.getAddress(process.env.TOKEN || DEFAULT_TOKEN);
    wbnb = ethers.getAddress(process.env.WBNB || DEFAULT_WBNB);
    const factoryAddr = ethers.getAddress(
      process.env.PCS_FACTORY || PCS_V2_FACTORY,
    );
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
    pairAddr = await factory.getPair(token, wbnb);
    if (pairAddr === ethers.ZeroAddress) {
      console.error(
        "在指定 Factory 上未找到该币对。若流动性在分叉 DEX，请设置 PCS_FACTORY 为对应 Factory 地址，或设置 LP_PAIR 为池子合约地址。",
      );
      process.exit(1);
    }
    pair = new ethers.Contract(pairAddr, PAIR_ABI, wallet);
    console.log("模式: Factory + TOKEN/WBNB");
  }

  const t0 = await pair.token0();
  const t1 = await pair.token1();
  token = token ?? t0;
  wbnb = wbnb ?? t1;

  console.log("钱包:", me);
  console.log("接收地址:", recipient);
  console.log("TOKEN(用于扫尾转账):", token);
  console.log("WBNB(用于扫尾转账):", wbnb);
  console.log("撤池后转 token:", removeLiquidity);
  console.log("DRY_RUN:", dryRun);
  console.log("---");

  console.log("LP Pair:", pairAddr);
  console.log("token0:", t0, "token1:", t1);

  const mcV1 = new ethers.Contract(MASTERCHEF_V1, MC_V1_ABI, wallet);
  const mcV2 = new ethers.Contract(MASTERCHEF_V2, MC_V2_ABI, wallet);

  async function unstakeFromMcV2() {
    const n = Number(await mcV2.poolLength());
    const found = [];
    for (let pid = 0; pid < n; pid++) {
      let lp;
      try {
        lp = await mcV2.lpToken(pid);
      } catch {
        continue;
      }
      if (lp.toLowerCase() !== pairAddr.toLowerCase()) continue;
      const info = await mcV2.userInfo(pid, me);
      const amount = info.amount;
      if (amount === 0n) continue;
      found.push({ pid, amount });
    }
    for (const { pid, amount } of found) {
      console.log(`MasterChef V2 pid=${pid} 质押数量: ${amount.toString()}`);
      if (dryRun) continue;
      try {
        const tx = await mcV2.withdraw(pid, amount);
        console.log("  withdraw tx:", tx.hash);
        await tx.wait();
      } catch (e) {
        console.warn("  withdraw 失败，尝试 emergencyWithdraw:", e.shortMessage || e.message);
        const tx2 = await mcV2.emergencyWithdraw(pid);
        console.log("  emergencyWithdraw tx:", tx2.hash);
        await tx2.wait();
      }
    }
    return found.length;
  }

  async function unstakeFromMcV1() {
    const n = Number(await mcV1.poolLength());
    const found = [];
    for (let pid = 0; pid < n; pid++) {
      let lp;
      try {
        const pi = await mcV1.poolInfo(pid);
        lp = pi.lpToken;
      } catch {
        continue;
      }
      if (lp.toLowerCase() !== pairAddr.toLowerCase()) continue;
      const info = await mcV1.userInfo(pid, me);
      const amount = info.amount;
      if (amount === 0n) continue;
      found.push({ pid, amount });
    }
    for (const { pid, amount } of found) {
      console.log(`MasterChef V1 pid=${pid} 质押数量: ${amount.toString()}`);
      if (dryRun) continue;
      try {
        const tx = await mcV1.withdraw(pid, amount);
        console.log("  withdraw tx:", tx.hash);
        await tx.wait();
      } catch (e) {
        console.warn("  withdraw 失败，尝试 emergencyWithdraw:", e.shortMessage || e.message);
        const tx2 = await mcV1.emergencyWithdraw(pid);
        console.log("  emergencyWithdraw tx:", tx2.hash);
        await tx2.wait();
      }
    }
    return found.length;
  }

  const v2Count = await unstakeFromMcV2();
  const v1Count = await unstakeFromMcV1();
  if (v2Count === 0 && v1Count === 0) {
    console.log("在 MasterChef V1/V2 未找到该 LP 池子的质押记录（可能已在钱包、或在其他合约/Syrup/第三方）。");
  }

  let lpBal = await pair.balanceOf(me);
  console.log("当前钱包 LP 余额:", lpBal.toString());

  if (lpBal === 0n) {
    console.log("没有可操作的 LP。若曾使用 Pancake V3 或 NFT 头寸，本脚本不适用。");
    return;
  }

  if (dryRun) {
    console.log("DRY_RUN 结束，未发送交易。");
    return;
  }

  if (!removeLiquidity) {
    const tx = await pair.transfer(recipient, lpBal);
    console.log("已转 LP 到接收地址 tx:", tx.hash);
    await tx.wait();
    console.log("完成。");
    return;
  }

  const router = new ethers.Contract(PCS_ROUTER, ROUTER_ABI, wallet);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);

  if ((await pair.allowance(me, PCS_ROUTER)) < lpBal) {
    const txA = await pair.approve(PCS_ROUTER, ethers.MaxUint256);
    console.log("approve Router tx:", txA.hash);
    await txA.wait();
  }

  const txR = await router.removeLiquiditySupportingFeeOnTransferTokens(
    t0,
    t1,
    lpBal,
    0n,
    0n,
    recipient,
    deadline,
  );
  console.log("removeLiquidity tx:", txR.hash);
  await txR.wait();

  const ercT = new ethers.Contract(token, ERC20_ABI, provider);
  const ercW = new ethers.Contract(wbnb, ERC20_ABI, provider);
  const balT = await ercT.balanceOf(me);
  const balW = await ercW.balanceOf(me);
  if (balT > 0n || balW > 0n) {
    console.log("钱包内剩余 TOKEN/WBNB，一并转给接收地址…");
    const wT = new ethers.Contract(token, ERC20_ABI, wallet);
    const wW = new ethers.Contract(wbnb, ERC20_ABI, wallet);
    if (balT > 0n) {
      const t = await wT.transfer(recipient, balT);
      console.log("  转 TOKEN tx:", t.hash);
      await t.wait();
    }
    if (balW > 0n) {
      const t = await wW.transfer(recipient, balW);
      console.log("  转 WBNB tx:", t.hash);
      await t.wait();
    }
  }

  console.log("完成：流动性已移除，代币已发往接收地址（含撤池直接收到的部分）。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
