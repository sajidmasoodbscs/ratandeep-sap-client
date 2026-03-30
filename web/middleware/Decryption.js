import crypto from 'crypto';

export const decrypt = (encryptedAPIURL, key) => {
  try {
    const textParts = encryptedAPIURL.split(":");
    const iv = Buffer.from(textParts.shift(), "hex");
    const encryptedText = textParts.join(":");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    console.log("Error in dcryption =>", error);
  }
};
