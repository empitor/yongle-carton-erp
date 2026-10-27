// 扫描真实暂存区与历史blob，只报告文件/规则，不输出密钥内容。
import {execFileSync} from 'node:child_process';
const git=(...args)=>execFileSync('git',args,{maxBuffer:64*1024*1024,encoding:'utf8'});
const findings=[];
const forbidden=/(^|\/)(node_modules|data|backups|work|outputs?|dist|\.playwright-cli)\/|\.env($|\.(?!example$))|\.(sqlite(?:-\w+)?|db|pem|key|pfx|p12|onnx|safetensors|log|zip|xlsx?|docx?|pdf)$/i;
const dummy=s=>/^(sk-(fictional|test|fake|mock|not-a-real|example|dummy|unit|secure-test|masked|super-test)|ghp_example)/i.test(s);
const inspect=(name,bytes,scope)=>{
 if(forbidden.test(name))findings.push({scope,file:name,rule:'禁止上传运行数据、凭据或资源'});
 if(bytes.length>50*1024*1024)findings.push({scope,file:name,rule:'超过50MB，检查大型资源'});
 if(bytes.includes(0))return;const content=bytes.toString('utf8');
 const patterns=[['API密钥',/\bsk-[A-Za-z0-9_-]{20,}\b/g],['GitHub令牌',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})\b/g],['私钥',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],['云访问凭据',/\bAKIA[A-Z0-9]{16}\b/g]];
 for(const [rule,re]of patterns)for(const m of content.matchAll(re))if(!dummy(m[0]))findings.push({scope,file:name,rule});
};
const index=git('ls-files','--stage','-z').split('\0').filter(Boolean);
for(const line of index){const m=/^\d+ ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(line);if(!m||m[2]!=='0')throw Error('暂存区存在未解决冲突');inspect(m[3],execFileSync('git',['cat-file','blob',m[1]],{maxBuffer:64*1024*1024}),'staged');}
const revisions=git('rev-list','--all').trim();
if(revisions){const objects=git('rev-list','--objects','--all').split('\n');for(const line of objects){const m=/^([0-9a-f]+) (.+)$/.exec(line);if(!m)continue;if(git('cat-file','-t',m[1]).trim()!=='blob')continue;inspect(m[2],execFileSync('git',['cat-file','blob',m[1]],{maxBuffer:64*1024*1024}),'history');}}
if(findings.length){console.error(JSON.stringify({ok:false,findings},null,2));process.exitCode=1;}else console.log(JSON.stringify({ok:true,stagedFiles:index.length,history:revisions?'已逐个检查历史blob':'无已有提交历史',note:'规则扫描不能代替人工检查；已按发布白名单排除本机数据与历史报告'}));
