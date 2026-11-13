import * as snarkjs from 'snarkjs'; import fs from 'fs';
const C='../../circuits/';
const vk=JSON.parse(fs.readFileSync('../../circuits/gatekeeper_vk.json'));
const base={minimum:1000,publicBalance:1460,amount:500,maxTransfer:1000,recipient:111,conditionRecipient:111,expiryBlock:19842201,currentBlock:19832000,taskId:42,salt:7,decision:1,registeredVkHash:999,proofVkHash:999};
async function t(name,over){const inp={...base,...over};
 try{const {proof,publicSignals}=await snarkjs.groth16.fullProve(inp,C+'gatekeeper.wasm',C+'gatekeeper_final.zkey');
  const ok=await snarkjs.groth16.verify(vk,publicSignals,proof);console.log(name,'OK verify=',ok,JSON.stringify(publicSignals));}
 catch(e){console.log(name,'FAIL',String(e.message).split('\n')[0]);}}
await t('valid-approve',{});
await t('valid-reject',{decision:0});
await t('vk-sub-approve',{proofVkHash:998});
await t('vk-sub-reject',{proofVkHash:998,decision:0});
await t('threshold-approve',{publicBalance:900});
await t('threshold-reject',{publicBalance:900,decision:0});
await t('expired-approve',{currentBlock:19842201});
await t('recip-approve',{recipient:112});
await t('overflow-approve',{amount:1001});
await t('overflow-reject',{amount:1001,decision:0});
await t('decision2',{decision:2});
process.exit(0);
