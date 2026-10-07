// Fixed reviewed leaf: no imports, subprocesses, network, eval or dynamic code.
console.log(JSON.stringify({ kind: "fixed-service-leaf", value: process.env.FIXTURE_VALUE, keys: Object.keys(process.env).sort(), cwd: process.cwd(), pid: process.pid }));
setTimeout(() => console.log("fixed-service-leaf-complete"), 1500);
