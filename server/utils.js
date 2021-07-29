module.exports.writeError = (res, statusCode, errMsg) => {
  console.error('Writing error', statusCode, errMsg);
  res.status(statusCode);
  res.json({ error: { message: errMsg } });
};
