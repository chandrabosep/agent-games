import * as snarkjs from 'snarkjs'; import {buildPoseidon} from 'circomlibjs';
const C='../../circuits/'; const P=await buildPoseidon(); const H=a=>P.F.toString(P(a));
const params=JSON.parse(process.argv[2]), salt=12345n, commitment=H([...params,salt]);
const base={matchId:777,turnNumber:3,selfBalance:95,opponentBalance:105,circuitVersion:1,strategyParams:params,salt,commitment};
for(const [a,amt] of [[0,0],[1,0],...Array.from({length:11},(_,i)=>[2,i])]){
 try{const {publicSignals}=await snarkjs.groth16.fullProve({...base,action:a,amount:amt},C+'vfy-policy.wasm',C+'vfy-policy_final.zkey');console.log('PASS action',a,'amt',amt,JSON.stringify(publicSignals));}catch(e){console.log("fail",a,amt,String(e.message).split("\n")[0].slice(-40))}
}
process.exit(0);
