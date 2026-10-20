// Pacsun registration person and request body. No k6 or Node imports: the k6 journey
// (./endpoints.js) and prep/create-accounts.mjs both use it, so the two stay identical.
// Body as captured from the iOS 9.0.0 dev app (POST /account/register, guest token Bearer).

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const digit = () => 2 + Math.floor(Math.random() * 8);

// `r` is client.registration from config.js; `emailPattern` (optional) overrides r.emailPattern.
// {id} in the pattern becomes 16 random hex characters. The password is generated per account.
export function newPerson(r, emailPattern = r.emailPattern) {
  const uid = crypto.randomUUID().replace(/-/g, '');
  const mm = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const dd = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  return {
    firstName: pick(r.firstNames),
    lastName: pick(r.lastNames),
    email: emailPattern.replace('{id}', uid.slice(0, 16)),
    // 10 digits, area code and exchange not starting with 0/1
    phone: `${digit()}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}${digit()}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
    zip: pick(r.zips),
    birthday: `${mm}/${dd}`, // the app sends month/day only
    password: `K6!${uid.slice(16, 28)}a1`,
  };
}

export function registerBody(p) {
  return {
    profile: {
      customData: { shoppingForUnisex: true, shoppingForKids: true, smsMessageEnabled: false, birthday: p.birthday, shoppingForMen: true, zip: p.zip, shoppingForWomen: true },
      firstName: p.firstName,
      lastName: p.lastName,
      phone: p.phone,
      email: p.email,
      isNewsletterEnabled: true,
    },
    credentials: { username: p.email, password: p.password },
  };
}
