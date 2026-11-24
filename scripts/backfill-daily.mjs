import {backfillDaily} from '../daily-history.mjs';
const result=await backfillDaily();console.log(JSON.stringify(result,null,2));
if(result.complete!==result.total||result.unavailable)process.exitCode=1;
