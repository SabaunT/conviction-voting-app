import 'core-js/stable'
import 'regenerator-runtime/runtime'
import Aragon, { events } from '@aragon/api'
import { addressesEqual, toUtf8 } from './lib/web3-utils'
import { hasLoadedTokenSettings, loadTokenSettings } from './token-settings'
import tokenAbi from './abi/minimeToken.json'
import {
  vaultAbi,
  getVaultInitializationBlock,
  updateBalances,
} from './vault-balance'

const app = new Aragon()

/*
 * Calls `callback` exponentially, everytime `retry()` is called.
 * Returns a promise that resolves with the callback's result if it (eventually) succeeds.
 *
 * Usage:
 *
 * retryEvery(retry => {
 *  // do something
 *
 *  if (condition) {
 *    // retry in 1, 2, 4, 8 seconds… as long as the condition passes.
 *    retry()
 *  }
 * }, 1000, 2)
 *
 */
const retryEvery = async (
  callback,
  { initialRetryTimer = 1000, increaseFactor = 3, maxRetries = 3 } = {}
) => {
  const sleep = time => new Promise(resolve => setTimeout(resolve, time))

  let retryNum = 0
  const attempt = async (retryTimer = initialRetryTimer) => {
    try {
      return await callback()
    } catch (err) {
      if (retryNum === maxRetries) {
        throw err
      }
      ++retryNum

      // Exponentially backoff attempts
      const nextRetryTime = retryTimer * increaseFactor
      console.log(
        `Retrying in ${nextRetryTime}s... (attempt ${retryNum} of ${maxRetries})`
      )
      await sleep(nextRetryTime)
      return attempt(nextRetryTime)
    }
  }

  return attempt()
}

// Get the token addresses and vault to initialize ourselves
retryEvery(() =>
  Promise.all([
    app.call('stakeToken').toPromise(),
    app.call('vault').toPromise(),
    app.call('requestToken').toPromise(),
  ])
    .then(initialize)
    .catch(err => {
      console.error(
        'Could not start background script execution due to the contract not loading the stakeToken, vault, or requestToken:',
        err
      )
      throw err
    })
)

async function initialize([
  stakeTokenAddress,
  vaultAddress,
  requestTokenAddress,
]) {
  const stakeToken = {
    contract: app.external(stakeTokenAddress, tokenAbi),
    address: stakeTokenAddress,
  }
  const vault = {
    contract: app.external(vaultAddress, vaultAbi),
    address: vaultAddress,
  }

  async function reducer(state, { event, returnValues, blockNumber, address }) {
    let nextState = { ...state }

    if (addressesEqual(address, stakeTokenAddress)) {
      switch (event) {
        case 'Transfer':
          const tokenSupply = await stakeToken.contract
            .totalSupply()
            .toPromise()
          nextState = {
            ...nextState,
            stakeToken: {
              ...nextState.stakeToken,
              tokenSupply,
            },
          }
          console.log(nextState)
          return nextState
        default:
          return nextState
      }
    }

    // Vault event
    if (addressesEqual(address, vaultAddress)) {
      if (returnValues.token === requestTokenAddress) {
        return {
          ...nextState,
          requestToken: await getRequestTokenSettings(
            returnValues.token,
            vault
          ),
        }
      }
    }

    switch (event) {
      case 'ProposalAdded': {
        const { entity, id, title, amount, beneficiary, link } = returnValues
        const newProposal = {
          id: parseInt(id),
          name: title,
          link: link && toUtf8(link), // Can be an HTTP or IPFS link
          requestedAmount: parseInt(amount),
          creator: entity,
          beneficiary,
        }
        nextState.proposals.push(newProposal)
        break
      }
      case 'StakeChanged': {
        const {
          entity,
          id,
          tokensStaked,
          totalTokensStaked,
          conviction,
        } = returnValues
        nextState.convictionStakes.push({
          entity,
          proposal: parseInt(id),
          tokensStaked: parseInt(tokensStaked),
          totalTokensStaked: parseInt(totalTokensStaked),
          time: blockNumber,
          conviction: parseInt(conviction),
        })
        break
      }
      case 'ProposalExecuted': {
        const { id } = returnValues
        nextState = {
          ...nextState,
          proposals: nextState.proposals.map(proposal => {
            if (proposal.id === parseInt(id)) {
              return { ...proposal, executed: true }
            }
            return proposal
          }),
        }
        break
      }
      case events.SYNC_STATUS_SYNCING:
        nextState = { ...nextState, isSyncing: true }
        break
      case events.SYNC_STATUS_SYNCED:
        nextState = { ...nextState, isSyncing: false }
        break
    }

    console.log(nextState)
    return nextState
  }

  const storeOptions = {
    externals: [
      { contract: stakeToken.contract, initializationBlock: 0 },
      {
        contract: vault.contract,
        initializationBlock: await getVaultInitializationBlock(vault.contract),
      },
    ],
    init: initState(stakeToken, vault, requestTokenAddress),
  }

  return app.store(reducer, storeOptions)
}

function initState(stakeToken, vault, requestTokenAddress) {
  return async cachedState => {
    const globalParams =
      (cachedState && cachedState.globalParams) || (await loadGlobalParams())

    const stakeTokenSettings = hasLoadedTokenSettings(cachedState)
      ? cachedState.stakeTokenSettings
      : await loadTokenSettings(stakeToken.contract)

    const requestTokenSettings = await getRequestTokenSettings(
      requestTokenAddress,
      vault
    )

    app.identify(
      `${stakeTokenSettings.tokenSymbol}-${requestTokenSettings.symbol}`
    )

    const inititalState = {
      proposals: [],
      convictionStakes: [],
      ...cachedState,
      globalParams,
      stakeToken: stakeTokenSettings,
      requestToken: requestTokenSettings,
      isSyncing: true,
    }
    return inititalState
  }
}

async function getRequestTokenSettings(address, vault) {
  return (
    { ...(await updateBalances([], address, app, vault))[0], address } || {}
  )
}

async function loadGlobalParams() {
  const [decay, maxRatio, weight] = await Promise.all([
    app.call('decay').toPromise(),
    app.call('maxRatio').toPromise(),
    app.call('weight').toPromise(),
  ])
  return {
    alpha: parseInt(decay) / 10,
    maxRatio: parseInt(maxRatio) / 10,
    weight: parseInt(weight) / 100,
  }
}
