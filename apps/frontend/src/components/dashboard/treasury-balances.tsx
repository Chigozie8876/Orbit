"use client";
import { useEffect, useMemo, useState } from "react";
type Asset={code:string;amount:number;usd:number};
const symbols:Record<string,string>={USD:"$",EUR:"€",GBP:"£"};
export function TreasuryBalances({address,network}:{address:string;network:string}){
 const[assets,setAssets]=useState<Asset[]>([]),[fiat,setFiat]=useState("USD"),[rates,setRates]=useState<Record<string,number>>({USD:1,EUR:.92,GBP:.79}),[loading,setLoading]=useState(false);
 useEffect(()=>{try{const v=localStorage.getItem("orbit_treasury_fiat");if(v)setFiat(v)}catch{}},[]);
 useEffect(()=>{try{localStorage.setItem("orbit_treasury_fiat",fiat)}catch{}},[fiat]);
 useEffect(()=>{if(!address)return;const c=new AbortController();setLoading(true);const horizon=network==="stellar-mainnet"?"https://horizon.stellar.org":"https://horizon-testnet.stellar.org";
 Promise.all([
  fetch(horizon+"/accounts/"+address,{signal:c.signal}).then(r=>r.ok?r.json():Promise.reject(new Error("account unavailable"))),
  fetch("https://api.frankfurter.app/latest?from=USD&to=EUR,GBP",{signal:c.signal}).then(r=>r.ok?r.json():null).catch(()=>null),
  fetch("https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd",{signal:c.signal}).then(r=>r.ok?r.json():null).catch(()=>null)
 ]).then(([account,fx,xlm])=>{if(fx?.rates)setRates({USD:1,...fx.rates});const x=Number(xlm?.stellar?.usd)||0;setAssets((account.balances||[]).map((b:{asset_type:string;asset_code?:string;balance:string})=>{const code=b.asset_type==="native"?"XLM":b.asset_code||"ASSET",amount=Number(b.balance)||0;return{code,amount,usd:code==="XLM"?amount*x:code==="USDC"?amount:code==="EURC"?amount/(Number(fx?.rates?.EUR)||.92):0}}).filter((a:Asset)=>["XLM","USDC","EURC"].includes(a.code))) }).catch(()=>setAssets([])).finally(()=>setLoading(false));return()=>c.abort()},[address,network]);
 const total=assets.reduce((s,a)=>s+a.usd,0),rate=rates[fiat]||1;
 const gradient=useMemo(()=>{if(!total)return"conic-gradient(#e5e5e5 0 100%)";let at=0;const colors=["#171717","#737373","#d4d4d4"];return"conic-gradient("+assets.map((a,i)=>{const from=at;at+=a.usd/total*100;return colors[i%3]+" "+from+"% "+at+"%"}).join(",")+")"},[assets,total]);
 if(!address)return null;
 return <section className="rounded-xl border border-black/10 bg-white p-6 shadow-xs"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold">Treasury balances</h2><p className="text-xs text-neutral-500">Live Horizon balances with non-blocking FX conversion.</p></div><select value={fiat} onChange={e=>setFiat(e.target.value)} className="rounded-lg border px-3 py-2 text-sm"><option>USD</option><option>EUR</option><option>GBP</option></select></div><div className="mt-6 grid gap-6 md:grid-cols-[160px_1fr]"><div className="mx-auto flex h-36 w-36 items-center justify-center rounded-full" style={{background:gradient}}><div className="flex h-24 w-24 items-center justify-center rounded-full bg-white text-center"><div><div className="text-xs text-neutral-500">Total</div><div className="font-bold">{symbols[fiat]}{(total*rate).toLocaleString(undefined,{maximumFractionDigits:2})}</div></div></div></div><div className="grid gap-3 sm:grid-cols-3">{loading?[0,1,2].map(i=><div key={i} className="h-24 animate-pulse rounded-lg bg-neutral-100"/>):assets.map(a=><div key={a.code} className="rounded-lg border p-4"><div className="text-xs font-semibold text-neutral-500">{a.code}</div><div className="mt-1 text-lg font-bold">{a.amount.toLocaleString(undefined,{maximumFractionDigits:7})}</div><div className="mt-1 text-xs text-neutral-500">≈ {symbols[fiat]}{(a.usd*rate).toLocaleString(undefined,{maximumFractionDigits:2})}</div></div>)}</div></div></section>
}
