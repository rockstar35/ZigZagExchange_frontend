import { ethers } from "ethers";
import APIProvider from "./APIProvider";
import balanceBundleABI from "lib/contracts/BalanceBundle.json";
import erc20ContractABI from "lib/contracts/ERC20.json";
import wethContractABI from "lib/contracts/WETH.json";
import { balanceBundlerAddress } from "./../constants";

export default class APIArbitrumProvider extends APIProvider {
  accountState = {};
  evmCompatible = true;
  zksyncCompatible = false;
  _tokenInfo = {};
  defaultMarket = "USDC-USDT";

  getAccountState = async () => {
    return this.accountState;
  };

  getBalances = async () => {
    const balances = {};
    if (!this.accountState?.address) return balances;

    // generate token list
    const tokenInfoList = [];
    const tokenList = [];
    this.api.getCurrencies().forEach((token) => {
      const tokenInfo = this.api.getCurrencyInfo(token);
      if (!tokenInfo || !tokenInfo.address) return;

      tokenInfoList.push(tokenInfo);
      tokenList.push(tokenInfo.address);
    })

    // allways get ETH
    tokenInfoList.push({ decimals: 18, symbol: 'ETH' });
    tokenList.push(ethers.constants.AddressZero);

    // get token balance
    const erc20Contract = new ethers.Contract(
      balanceBundlerAddress,
      balanceBundleABI,
      this.api.rollupProvider
    );
    const balanceList = await erc20Contract.balances(
      [this.accountState.address],
      tokenList
    );
    const exchangeAddress = this.getExchangeAddress();

    // generate object
    for (let i = 0; i < tokenInfoList.length; i++) {
      let balanceBN = balanceList[i];
      const currencyInfo = tokenInfoList[i];

      let allowanceBN = ethers.BigNumber.from(0);
      if (currencyInfo.symbol === "ETH") {
        allowanceBN = ethers.constants.MaxUint256;
      } else if (
        currencyInfo &&
        exchangeAddress &&
        balanceBN.gt(0)
      ) {
        allowanceBN = await this.getAllowance(currencyInfo.address, exchangeAddress); // TODO replace
      }
      const valueReadable =
        balanceBN && currencyInfo
          ? ethers.utils.formatUnits(
              balanceBN,
              currencyInfo.decimals
            )
          : 0;
      const allowanceReadable =
        allowanceBN && currencyInfo
          ? ethers.utils.formatUnits(
              allowanceBN,
              currencyInfo.decimals
            )
          : 0;

      balances[currencyInfo.symbol] = {
        value: balanceBN,
        valueReadable,
        allowance: allowanceBN,
        allowanceReadable,
      };
    }

    return balances;
  };

  getAllowance = async (tokenAddress, contractAddress) => {
    if (!this.accountState.address || !contractAddress || !tokenAddress) return 0;
    const erc20Contract = new ethers.Contract(
      tokenAddress,
      erc20ContractABI,
      this.api.rollupProvider
    );

    const allowance = await erc20Contract.allowance(
      this.accountState.address,
      contractAddress
    );

    return ethers.BigNumber.from(allowance);
  };

  submitOrder = async (
    market,
    side,
    baseAmountBN,
    quoteAmountBN,
    expirationTimeSeconds
  ) => {
    const marketInfo = this.api.marketInfo[`${this.network}:${market}`];

    const [baseToken, quoteToken] = market.split("-");
    let makerToken,
      takerToken,
      makerAmountBN,
      takerAmountBN,
      gasFeeBN,
      balanceBN;
    if (side === "s") {
      makerToken = marketInfo.baseAsset.address;
      takerToken = marketInfo.quoteAsset.address;
      makerAmountBN = baseAmountBN;
      takerAmountBN = quoteAmountBN.mul(99999).div(100000);
      gasFeeBN = ethers.utils.parseUnits(
        Number(marketInfo.baseFee).toFixed(marketInfo.baseAsset.decimals),
        marketInfo.baseAsset.decimals
      );
      balanceBN = ethers.BigNumber.from(this.api.balances[this.network][baseToken].value);
    } else {
      makerToken = marketInfo.quoteAsset.address;
      takerToken = marketInfo.baseAsset.address;
      makerAmountBN = quoteAmountBN;
      takerAmountBN = baseAmountBN.mul(99999).div(100000);
      gasFeeBN = ethers.utils.parseUnits(
        Number(marketInfo.quoteFee).toFixed(marketInfo.quoteAsset.decimals),
        marketInfo.quoteAsset.decimals
      );
      balanceBN = ethers.BigNumber.from(this.api.balances[this.network][quoteToken].value);
    }

    // add margin of error to gas fee
    gasFeeBN = gasFeeBN.mul(100).div(99)

    const makerVolumeFeeBN = quoteAmountBN
      .div(10000)
      .mul(marketInfo.makerVolumeFee * 100);
    const takerVolumeFeeBN = baseAmountBN
      .div(10000)
      .mul(marketInfo.takerVolumeFee * 100);

    // size check
    if (makerVolumeFeeBN.gte(takerVolumeFeeBN)) {
      balanceBN = balanceBN.sub(gasFeeBN).sub(makerVolumeFeeBN);
    } else {
      balanceBN = balanceBN.sub(gasFeeBN).sub(takerVolumeFeeBN);
    }
    const delta = makerAmountBN.mul("1000").div(balanceBN).toNumber();
    if (delta > 1001) {
      // 100.1 %
      throw new Error(`Amount exceeds balance.`);
    }
    // prevent dust issues
    if (delta > 999) {
      // 99.9 %
      makerAmountBN = balanceBN;
    }

    const Order = {
      makerAddress: this.accountState.address,
      makerToken: makerToken,
      takerToken: takerToken,
      feeRecipientAddress: marketInfo.feeAddress,
      makerAssetAmount: makerAmountBN.toString(),
      takerAssetAmount: takerAmountBN.toString(),
      makerVolumeFee: makerVolumeFeeBN.toString(),
      takerVolumeFee: takerVolumeFeeBN.toString(),
      gasFee: gasFeeBN.toString(),
      expirationTimeSeconds: expirationTimeSeconds.toFixed(0),
      salt: (Math.random() * 123456789).toFixed(0),
    };

    const domain = {
      name: "ZigZag",
      version: "4",
      chainId: this.network,
    };

    const types = {
      Order: [
        { name: "makerAddress", type: "address" },
        { name: "makerToken", type: "address" },
        { name: "takerToken", type: "address" },
        { name: "feeRecipientAddress", type: "address" },
        { name: "makerAssetAmount", type: "uint256" },
        { name: "takerAssetAmount", type: "uint256" },
        { name: "makerVolumeFee", type: "uint256" },
        { name: "takerVolumeFee", type: "uint256" },
        { name: "gasFee", type: "uint256" },
        { name: "expirationTimeSeconds", type: "uint256" },
        { name: "salt", type: "uint256" },
      ],
    };

    const signer = await this.api.rollupProvider.getSigner();
    const signature = await signer._signTypedData(domain, types, Order);

    Order.signature = signature;
    this.api.send("submitorder3", [this.network, market, Order]);
    return Order;
  };

  signIn = async () => {
    console.log("signing in to arbitrum");
    const [account] = await this.api.web3.eth.getAccounts();
    const balances = await this.getBalances();
    this.accountState = {
      id: account,
      address: account,
      committed: {
        balances,
      },
    };

    return this.accountState;
  };

  approveExchangeContract = async (token, amount) => {
    const exchangeAddress = this.getExchangeAddress();
    if (!exchangeAddress) throw new Error(`No exchange contract address`);

    const currencyInfo = this.api.getCurrencyInfo(token);
    if (!currencyInfo.address)
      throw new Error(`ERC20 address for ${token} not found`);

    let amountBN;
    if (!amount) {
      amountBN = ethers.constants.MaxUint256;
    } else {
      amountBN = ethers.utils.parseUnits(
        amount.toFixed(currencyInfo.decimals),
        currencyInfo.decimals
      );
    }

    const signer = await this.api.rollupProvider.getSigner();
    const erc20Contract = new ethers.Contract(
      currencyInfo.address,
      erc20ContractABI,
      signer
    );

    const tx = await erc20Contract.approve(exchangeAddress, amountBN);
    const { status } = await tx.wait();

    // update account balance
    if (status) this.api.getBalances();
    
    return status;
  };

  warpETH = async (amountBN) => {
    const wethInfo = this.api.getCurrencyInfo("WETH");
    if (!wethInfo) throw new Error("No WETH contract address");

    const signer = await this.api.rollupProvider.getSigner();
    const wethContract = new ethers.Contract(
      wethInfo.address,
      wethContractABI,
      signer
    );
    await wethContract.deposit({ value: amountBN });

    // update account balance
    await this.api.getBalances();
    return true;
  };

  unWarpETH = async (amountBN) => {
    const wethInfo = this.api.getCurrencyInfo("WETH");
    if (!wethInfo) throw new Error("No WETH contract address");

    const signer = await this.api.rollupProvider.getSigner();
    const wethContract = new ethers.Contract(
      wethInfo.address,
      wethContractABI,
      signer
    );

    await wethContract.withdraw(amountBN);

    // update account balance
    await this.api.getBalances();
    return true;
  };

  getWrapFees = async () => {
    let feeData = {
      gasPrice: ethers.BigNumber.from(2_500_000_000), // 2.5 GWEI
    };
    try {
      feeData = await this.api.rollupProvider.getFeeData();
    } catch (e) {
      console.log(`No fee data, error: ${e.message}`);
    }
    const feeResult = ethers.utils
      .formatEther(feeData.gasPrice.mul(450_000))
      .toString();
    return {
      wrap: feeResult,
      unwrap: feeResult,
    };
  };

  getExchangeAddress = () => {
    const marketInfo = this.api.marketInfo[`${this.network}:ZZ-USDC`];
    return marketInfo?.exchangeAddress;
  };

  signMessage = async (message) => {
    const signer = await this.api.rollupProvider.getSigner();
    return await signer.signMessage(message);
  }
}
