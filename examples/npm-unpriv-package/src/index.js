function identity() {
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    user: process.env.USER || "",
    home: process.env.HOME || "",
  };
}

function message() {
  const current = identity();
  return `unpriv npm fixture user=${current.user} uid=${current.uid} gid=${current.gid} home=${current.home}`;
}

if (require.main === module) {
  console.log(message());
}

module.exports = { identity, message };
