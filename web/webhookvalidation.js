import crypto from 'crypto';
export const verify = async (hmacHeader, data) => {

    const VERIFICATION_KEY = '1b2a4477ac0de237f0c480d151fb26f99852f9b538e7da01304bdef6946d5241';

    const hmac = crypto
        .createHmac('sha256', VERIFICATION_KEY)
        .update(data, 'utf8', 'hex')
        .digest('base64');
    let valid = true;

    if (hmacHeader === hmac) {

        console.log('Phew, it came from Shopify!')

    } else {

        console.log('Danger! Not from Shopify!')

        valid = false;

        console.log("Received hmach in header :", hmacHeader);

        console.log("Generated hmach in header :", hmac)
    }
    return valid;

};

