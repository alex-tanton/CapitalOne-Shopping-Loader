// Pure data logic: normalize feed items, filter, sort. No DOM access, so it can be tested in Node.
(function (root) {
  'use strict';

  const SAFE_LINK = /^https:\/\/capitaloneshopping\.com\//;

  // "$1,000" -> 1000, "up to 4%" -> 4, "60%" -> 60
  function num(s) {
    if (s == null) return null;
    if (typeof s === 'number') return s;
    const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function normalize(raw) {
    if (!raw || typeof raw.href !== 'string' || !SAFE_LINK.test(raw.href)) return null;
    const st = raw.stats || {};
    const trk = (raw.__mirage && raw.__mirage.trackProps) || {};

    const tiers = (st.rewardTiers || []).map(t => ({
      amount: t.reward && t.reward.type === 'fixed' ? t.reward.value / 100 : null,
      amountText: (t.reward && t.reward.displayValue) || '',
      spend: t.spendCents != null ? t.spendCents / 100 : null,
      spendText: t.displaySpendValue || t.displaySpendCents || ''
    }));
    const withAmount = tiers.filter(t => t.amount != null);
    const best = withAmount.slice().sort((a, b) => b.amount - a.amount)[0] || null;

    const cashbackText = st.cashback || st.cashbackV2 || '';
    const endMs = raw.end ? Date.parse(raw.end) : NaN;

    return {
      id: trk.feedItemId || raw.href,
      kind: raw.type || '',
      label: raw.filterLabel || 'Other',
      level: raw.itemLevel || '',
      merchant: raw.merchantName || trk.brand || trk.tld || 'Unknown',
      tld: trk.tld || '',
      title: raw.primaryText || '',
      pill: (raw.pill && raw.pill.text) || '',
      subtitle: raw.bonusOfferSubtitle || '',
      cta: raw.cta || 'Activate Offer',
      href: raw.href,
      end: isNaN(endMs) ? null : endMs,
      tiers,
      bonus: best ? best.amount : null,
      bonusSpend: best ? best.spend : null,
      bonusRatio: best && best.spend ? (best.amount / best.spend) * 100 : null,
      cashbackText,
      cashbackPct: num(st.cashbackV2 != null ? st.cashbackV2 : st.cashback),
      cashbackAmount: num(st.cashbackAmount),
      maxPayout: st.rewardMaxPayout || '',
      percentOff: num(st.percentOff),
      newPrice: num(st.newPrice),
      oldPrice: num(st.oldPrice),
      priceAfterRewards: num(st.priceAfterRewards),
      popularity: num(st.productPopularity),
      exclusions: st.exclusionsText || ''
    };
  }

  // ── Sorting ──────────────────────────────────────────────────────
  const by = (get, dir) => (a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;           // missing values always sort last
    if (y == null) return -1;
    return dir * (x - y);
  };

  const SORTS = {
    site:       { label: 'Site order',                cmp: null },
    bonus:      { label: 'Bonus amount, high to low',  cmp: by(i => i.bonus, -1) },
    bonusRatio: { label: 'Bonus as % of spend',        cmp: by(i => i.bonusRatio, -1) },
    spendLow:   { label: 'Spend needed, low to high',  cmp: by(i => i.bonusSpend, 1) },
    cashback:   { label: 'Cashback %, high to low',    cmp: by(i => i.cashbackPct, -1) },
    percentOff: { label: 'Price drop %, high to low',  cmp: by(i => i.percentOff, -1) },
    priceLow:   { label: 'Price, low to high',         cmp: by(i => i.newPrice, 1) },
    priceHigh:  { label: 'Price, high to low',         cmp: by(i => i.newPrice, -1) },
    popularity: { label: 'Popularity',                 cmp: by(i => i.popularity, -1) },
    ending:     { label: 'Ending soonest',             cmp: by(i => i.end, 1) },
    merchant:   { label: 'Merchant A to Z',            cmp: (a, b) => a.merchant.localeCompare(b.merchant) }
  };

  // ── Filtering ────────────────────────────────────────────────────
  // Empty lists mean "no restriction". Several values within one filter are OR'd; different filters are AND'd.
  const DEFAULT_FILTERS = {
    q: '', labels: [], kinds: [], levels: [], merchants: [],
    minBonus: null, maxSpend: null, onePerMerchant: false
  };

  function haystack(i) {
    return `${i.merchant} ${i.tld} ${i.title} ${i.pill} ${i.subtitle} ${i.label} ${i.cashbackText}`.toLowerCase();
  }

  function matches(i, f) {
    if (f._labels.size && !f._labels.has(i.label)) return false;
    if (f._levels.size && !f._levels.has(i.level)) return false;
    if (f._merchants.size && !f._merchants.has(i.merchant)) return false;
    if (f._kinds.size) {
      const ok = (f._kinds.has('bonus') && i.bonus != null) || (f._kinds.has('cashback') && i.cashbackPct != null);
      if (!ok) return false;
    }
    if (f.minBonus != null && (i.bonus == null || i.bonus < f.minBonus)) return false;
    if (f.maxSpend != null && (i.bonusSpend == null || i.bonusSpend > f.maxSpend)) return false;
    if (f.q) {
      const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = haystack(i);
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  }

  function query(items, filters, sortKey) {
    const f = Object.assign({}, DEFAULT_FILTERS, filters);
    f._labels = new Set(f.labels); f._levels = new Set(f.levels);
    f._merchants = new Set(f.merchants); f._kinds = new Set(f.kinds);
    let out = items.filter(i => matches(i, f));
    const s = SORTS[sortKey];
    if (s && s.cmp) out = out.slice().sort(s.cmp);
    if (f.onePerMerchant) {
      const seen = new Set();
      out = out.filter(i => {
        const k = i.tld || i.merchant;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return out;
  }

  const api = { normalize, query, SORTS, DEFAULT_FILTERS, num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.C1S = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
