#!/bin/sh
# Private Bitcoin test network for the wallet tests (own data folder, port 18543). Usage: tools/regtest.sh start|stop|cli ...
BIN="${BITCOIN_BIN:-$(dirname "$(command -v bitcoind)")}"; DIR="$(cd "$(dirname "$0")/.." && pwd)/regtest-data"
ARGS="-regtest -datadir=$DIR -rpcuser=u -rpcpassword=p -rpcport=18543"
case "$1" in
  start) "$BIN/bitcoind" $ARGS -port=18544 -daemon -server=1 -txindex=1 -fallbackfee=0.0001 -listen=0 -acceptnonstdtxn=0 && sleep 3 ;;
  stop)  "$BIN/bitcoin-cli" $ARGS stop ;;
  cli)   shift; "$BIN/bitcoin-cli" $ARGS "$@" ;;
esac
