import * as snarkjs from 'snarkjs'; import fs from 'fs'; import {buildPoseidon} from 'circomlibjs';
const C='../../circuits/'; const vk=JSON.parse(fs.readFileSync('../../circuits/vfy-policy_vk.json'));
const P=await buildPoseidon(); const H=a=>P.F.toString(P(a));
const params=[1,2,3,4,5,6,7,8], salt=12345n;
const cands={'P(params,salt)':H([...params,salt]),'P(salt,params)':H([salt,...params]),'P(P(params),salt)':H([H(params),salt])};
const base={matchId:777,turnNumber:3,selfBalance:95,opponentBalance:105,circuitVersion:1,strategyParams:params,salt};
async function run(label,inp){try{const {proof,publicSignals}=await snarkjs.groth16.fullProve(inp,C+'vfy-policy.wasm',C+'vfy-policy_final.zkey');console.log(label,'OK',await snarkjs.groth16.verify(vk,publicSignals,proof),JSON.stringify(publicSignals));return true}catch(e){console.log(label,'FAIL',String(e.message).split('\n')[0]);return false}}
let good=null;
for(const [k,c] of Object.entries(cands)){ for(const [a,amt] of [[0,0],[1,0],[2,5],[2,10]]){ if(await run(`${k} action=${a} amt=${amt}`,{...base,commitment:c,action:a,amount:amt})){good=c;} } }
process.exit(0);
