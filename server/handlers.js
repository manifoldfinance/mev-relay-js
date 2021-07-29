const fetch = require('node-fetch');
const Sentry = require('@sentry/node');
const AWS = require('aws-sdk');
const postgres = require('postgres');
const util = require('util');

const { writeError } = require('./utils');
const { checkBlacklist, getParsedTransactions, generateBundleHash } = require('./bundle');

const MIN_GAS_FLOOR = 42000;
function convertBundleFormat(bundle) {
  if (!Array.isArray(bundle[0])) {
    // is already v2 bundle, just return
    bundle[0].version = 2;
    return bundle[0];
  }

  const newBundle = {
    txs: bundle[0],
    blockNumber: bundle[1],
  };

  if (bundle[2]) {
    newBundle.minTimestamp = bundle[2];
  }

  if (bundle[3]) {
    newBundle.maxTimestamp = bundle[3];
  }

  return newBundle;
}
function convertSimBundleFormat(bundle) {
  if (!Array.isArray(bundle[0])) {
    return bundle[0];
  }

  const newBundle = {
    txs: bundle[0],
    blockNumber: bundle[1],
    stateBlockNumber: bundle[2],
  };

  if (bundle[3]) {
    newBundle.timestamp = bundle[3];
  }

  return newBundle;
}

class Handler {
  constructor(MINERS, promClient) {
    this.MINERS = MINERS;
    this.bundleCounter = new promClient.Counter({
      name: 'bundles',
      help: '# of bundles received',
    });
  }

  async handleSendBundle(req, res) {
    if (!req.body.params || !req.body.params[0]) {
      writeError(res, 400, 'missing params');
      return;
    }
    this.bundleCounter.inc();
    const bundle = convertBundleFormat(req.body.params);
    req.body.params = [bundle];

    const txs = bundle.txs;
    let bundleHash;

    try {
      const parsedTransactions = getParsedTransactions(txs);

      if (checkBlacklist(parsedTransactions)) {
        console.error(`txs was interacting with blacklisted address: ${txs}`);
        writeError(res, 400, 'blacklisted tx');
        return;
      }
      bundleHash = generateBundleHash(parsedTransactions);
    } catch (error) {
      console.error(`error decoding bundle: ${error}`);
      writeError(res, 400, 'unable to decode txs');
      return;
    }
    const blockParam = bundle.blockNumber;
    if (!blockParam) {
      writeError(res, 400, 'missing block param');
      return;
    }
    if (blockParam.slice(0, 2) !== '0x' || !(parseInt(blockParam, 16) > 0)) {
      writeError(res, 400, 'block param must be a hex int');
      return;
    }
    const minTimestamp = bundle.minTimestamp;
    if (minTimestamp && !(minTimestamp > 0)) {
      writeError(res, 400, 'minTimestamp must be an int');
      return;
    }
    const maxTimestamp = bundle.maxTimestamp;
    if (maxTimestamp && !(maxTimestamp > 0)) {
      writeError(res, 400, 'maxTimestamp must be an int');
      return;
    }

    const requests = [];

    console.log('req.body', req.body);
    this.MINERS.forEach((minerUrl) => {
      try {
        requests.push(
          fetch(`${minerUrl}`, {
            method: 'post',
            body: JSON.stringify(req.body),
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      } catch (error) {
        Sentry.captureException(error);
        console.error('Error calling miner', minerUrl, error);
      }
    });

    if (this.SQS_URL) {
      const params = {
        DelaySeconds: 0,
        MessageAttributes: {},
        MessageBody: JSON.stringify(req.body),
        QueueUrl: this.SQS_URL,
      };
      if (req.user.keyID) {
        params.MessageAttributes.KeyID = {
          DataType: 'String',
          StringValue: req.user.keyID,
        };
      }
      if (req.user.address) {
        params.MessageAttributes.SignerAddress = {
          DataType: 'String',
          StringValue: req.user.address,
        };
      }

      await this.sqs.sendMessage(params).promise();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.body.id, result: { bundleHash } }));
  }

  async handleCallBundle(req, res) {
    const bundle = convertSimBundleFormat(req.body.params);
    bundle.coinbase = process.env.COINBASE_ADDRESS;
    req.body.params = [bundle];

    const txs = bundle.txs;
    const parsedTransactions = getParsedTransactions(txs);
    try {
      if (checkBlacklist(parsedTransactions)) {
        console.error(`bundle was interacting with blacklisted address: ${parsedTransactions}`);
        writeError(res, 400, 'blacklisted tx');
        return;
      }
    } catch (error) {
      console.error(`error decoding bundle: ${error}`);
      writeError(res, 400, 'unable to decode txs');
      return;
    }

    try {
      const resp = await fetch(this.SIMULATION_RPC, {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await resp.json();
      if (result.result) {
        if (result.result.totalGasUsed < MIN_GAS_FLOOR) {
          writeError(res, 400, `bundle used too little gas, must use at least ${MIN_GAS_FLOOR}`);
        }
      }

      res.json(result);
    } catch (error) {
      console.error(`error simulating bundle: ${error}`);
      writeError(res, 400, 'failed to simulate');
    }
  }

  async handleUserStats(req, res) {
    if (req.user.keyID) {
      const stats = await this.sql`
      select
          *
      from
        stats_by_user_key_id
      where
          ${req.user.keyID} = user_key_id`;

      if (stats.length === 0) {
        return res.json({ error: { message: "stats don't exist for this user", code: -32602 } });
      }
      res.json({ result: stats[0] });
    } else {
      const stats = await this.sql`
      select
          *
      from
        stats_by_signing_address
      where
          ${req.user.address} = signing_address`;

      if (stats.length === 0) {
        return res.json({ error: { message: "stats don't exist for this user", code: -32602 } });
      }
      res.json({ result: stats[0] });
    }
  }
}

module.exports.Handler = Handler;
