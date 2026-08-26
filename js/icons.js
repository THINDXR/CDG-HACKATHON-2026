/*
 * ชุดไอคอนเส้น SVG ใช้แทน emoji ทั้งแอป
 *
 * emoji หน้าตาไม่เหมือนกันในแต่ละระบบปฏิบัติการ ปรับสีไม่ได้ และเบลอเมื่อขยาย
 * ไอคอนชุดนี้เป็นเวกเตอร์ทั้งหมด ใช้ currentColor จึงเปลี่ยนสีตามบริบทได้
 * และกำหนดขนาดด้วย width/height = 1em เพื่อให้กฎ font-size เดิมยังคุมขนาดได้เหมือนเคย
 */
window.Icons = (function () {
  const PATHS = {
    /* ---------- ประเภทภัยบนถนน ---------- */

    accident:
      '<path d="M4 14l1.4-4.3A2.2 2.2 0 0 1 7.5 8h9a2.2 2.2 0 0 1 2.1 1.7L20 14"/>' +
      '<path d="M3 14h18v3.5a.9.9 0 0 1-.9.9h-1.7a.9.9 0 0 1-.9-.9V16H6.5v1.5a.9.9 0 0 1-.9.9H3.9a.9.9 0 0 1-.9-.9z"/>' +
      '<path d="M6.5 11.2h2M15.5 11.2h2"/>',

    flood:
      '<path d="M2 10c2 0 2-1.6 4-1.6S8 10 10 10s2-1.6 4-1.6S16 10 18 10s2-1.6 4-1.6"/>' +
      '<path d="M2 15c2 0 2-1.6 4-1.6S8 15 10 15s2-1.6 4-1.6S16 15 18 15s2-1.6 4-1.6"/>' +
      '<path d="M2 20c2 0 2-1.6 4-1.6S8 20 10 20s2-1.6 4-1.6S16 20 18 20s2-1.6 4-1.6"/>',

    construction:
      '<path d="M12 3.5L18.5 19h-13z"/>' +
      '<path d="M4 21h16"/>' +
      '<path d="M9.4 12.5h5.2M8 16h8"/>',

    pothole:
      '<path d="M4.5 15.5c0-2.5 3.4-4.5 7.5-4.5s7.5 2 7.5 4.5S16.1 20 12 20s-7.5-2-7.5-4.5z"/>' +
      '<path d="M9 11l1.5-3.5M14 11.4l2-4"/>',

    obstacle:
      '<path d="M12 3.8L21 19.5H3z"/>' +
      '<path d="M12 10v4.2"/>' +
      '<path d="M12 17.2h.01"/>',

    traffic:
      '<rect x="7.5" y="2.8" width="9" height="18.4" rx="4"/>' +
      '<path d="M12 7.4h.01M12 12h.01M12 16.6h.01"/>',

    police:
      '<path d="M12 3l7 2.8v5.7c0 4-2.9 7.3-7 9.2-4.1-1.9-7-5.2-7-9.2V5.8z"/>' +
      '<path d="M12 8.4l1.2 2.5 2.7.4-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.4z"/>',

    fog:
      '<path d="M5 8.5h9M3 12h12M6 15.5h13M4 19h9"/>' +
      '<path d="M17.5 8.5h1.5M18 12h3M21 15.5h.01"/>',

    animal:
      '<circle cx="7.6" cy="9" r="1.7"/><circle cx="12" cy="6.9" r="1.7"/>' +
      '<circle cx="16.4" cy="9" r="1.7"/>' +
      '<path d="M12 12.2c-2.9 0-5 2-5 4.2 0 1.7 1.4 2.8 3 2.5l2-.4 2 .4c1.6.3 3-.8 3-2.5 0-2.2-2.1-4.2-5-4.2z"/>',

    /* ---------- แถบแท็บและปุ่มทั่วไป ---------- */

    map:
      '<path d="M9 4.2L3.6 6.6v13.2L9 17.4l6 2.4 5.4-2.4V4.2L15 6.6z"/>' +
      '<path d="M9 4.2v13.2M15 6.6v13.2"/>',

    dashboard:
      '<path d="M3.5 20.5h17"/>' +
      '<path d="M6.5 20.5v-6M11 20.5V6M15.5 20.5v-9M20 20.5v-4"/>',

    settings:
      '<circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M19.2 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1z"/>',

    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/>',

    pin:
      '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/>' +
      '<circle cx="12" cy="10" r="2.6"/>',

    bell:
      '<path d="M18 8.6a6 6 0 1 0-12 0c0 6.4-2.4 8.2-2.4 8.2h16.8S18 15 18 8.6z"/>' +
      '<path d="M13.7 20.5a2 2 0 0 1-3.4 0"/>',

    bellOff:
      '<path d="M13.7 20.5a2 2 0 0 1-3.4 0"/>' +
      '<path d="M17.4 13.4A11.7 11.7 0 0 1 18 8.6a6 6 0 0 0-9.3-5"/>' +
      '<path d="M6.3 6.3A6 6 0 0 0 6 8.6c0 6.4-2.4 8.2-2.4 8.2h13.2"/>' +
      '<path d="M3 3l18 18"/>',

    navigate: '<path d="M21 3L3.6 10.3a.6.6 0 0 0 .1 1.1l7.1 2.1 2.1 7.1a.6.6 0 0 0 1.1.1z"/>',

    flag:
      '<path d="M5 21V4"/>' +
      '<path d="M5 5h9.5l-1 3h5.5v7h-6l-1-3H5z"/>',

    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',

    // ป้ายบอกที่มาของรายงาน
    person: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
    spark:
      '<path d="M12 2.5l1.9 5.1 5.1 1.9-5.1 1.9L12 16.5l-1.9-5.1L5 9.5l5.1-1.9z"/>' +
      '<path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/>',

    compass:
      '<circle cx="12" cy="12" r="9"/>' +
      '<path d="M15.6 8.4l-2 5.2-5.2 2 2-5.2z"/>',

    chevronRight: '<path d="M9.5 5.5l6.5 6.5-6.5 6.5"/>',

    close: '<path d="M6 6l12 12M18 6L6 18"/>',

    check: '<path d="M4.5 12.5l5 5 10-11"/>',

    arrowLeft: '<path d="M19 12H5"/><path d="M11.5 5.5L5 12l6.5 6.5"/>',

    /* ---------- ลูกศรบอกทางเลี้ยว ---------- */

    turnLeft: '<path d="M20 20v-6a4 4 0 0 0-4-4H5"/><path d="M10 5L5 10l5 5"/>',
    turnRight: '<path d="M4 20v-6a4 4 0 0 1 4-4h11"/><path d="M14 5l5 5-5 5"/>',
    slightLeft: '<path d="M18 20v-7.2a4 4 0 0 0-1.2-2.9L8 3"/><path d="M8 8.5V3h5.5"/>',
    slightRight: '<path d="M6 20v-7.2a4 4 0 0 1 1.2-2.9L16 3"/><path d="M16 8.5V3h-5.5"/>',
    straight: '<path d="M12 20V5"/><path d="M6.5 10.5L12 5l5.5 5.5"/>',
    uturn: '<path d="M6 20V10a5 5 0 0 1 10 0v6"/><path d="M11.5 11.5L16 16l4.5-4.5"/>',
    roundabout:
      '<circle cx="9" cy="9.5" r="4"/>' +
      '<path d="M9 20v-6.5"/><path d="M13 8.5h6"/><path d="M15.5 5.5L19 8.5l-3.5 3"/>',
  };

  /**
   * @param {string} name ชื่อไอคอน
   * @returns {string} มาร์กอัป SVG ที่ปรับขนาดตาม font-size ของ element แม่
   */
  function get(name) {
    const body = PATHS[name] || PATHS.obstacle;
    return (
      '<svg class="icon" viewBox="0 0 24 24" width="1em" height="1em" fill="none" ' +
      'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body +
      '</svg>'
    );
  }

  /** เติมไอคอนให้ทุก element ที่มี data-icon (เรียกครั้งเดียวตอนเปิดแอป) */
  function paint(root = document) {
    root.querySelectorAll('[data-icon]').forEach((node) => {
      // ปุ่มบางตัวมี <span> ว่างไว้รอรับไอคอนโดยเฉพาะ เพื่อไม่ให้ทับข้อความข้าง ๆ
      const slot = node.querySelector(':scope > span:empty') || node;
      slot.innerHTML = get(node.dataset.icon);
    });
  }

  return { get, paint, has: (name) => name in PATHS };
})();
