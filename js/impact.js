/*
 * ตัวเลข "แอปช่วยลดอุบัติเหตุได้เท่าไร" สำหรับหน้าแดชบอร์ด
 *
 * ⚠️ ข้อควรรู้: ต้นแบบนี้เก็บข้อมูลไว้ใน localStorage ของเครื่องเดียว และรายงาน
 * หมดอายุใน 12 ชั่วโมง จึงไม่มีสถิติย้อนหลังจริงให้คำนวณ ชุดตัวเลขรายเดือนที่นี่
 * เป็น "ข้อมูลสาธิต" ที่สร้างจากสูตรตายตัว (ไม่สุ่มใหม่ทุกครั้งที่วาด) เพื่อให้เห็น
 * ว่าหน้าจอจะหน้าตาแบบไหนเมื่อต่อกับ backend จริง — หน้าจอกำกับไว้ชัดเจนว่าเป็นตัวอย่าง
 * เมื่อจะใช้งานจริง ให้เปลี่ยนเฉพาะ series() ให้ดึงจาก backend
 */
window.Impact = (function () {
  const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  // จำนวนอุบัติเหตุต่อ 1,000 เที่ยวเดินทาง ก่อนเริ่มใช้แอป (เส้นฐาน)
  const BASELINE = 8.4;

  /**
   * ชุดข้อมูล 6 เดือนล่าสุด นับถอยหลังจากเดือนปัจจุบัน
   * เส้นโค้งเป็นแบบลดลงเร็วช่วงแรกแล้วค่อย ๆ อิ่มตัว ซึ่งเป็นรูปแบบที่พบบ่อย
   * ในมาตรการด้านความปลอดภัย (คนปรับพฤติกรรมมากในช่วงแรก)
   */
  function series(months = 6) {
    const now = new Date();
    const out = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const step = months - 1 - i; // 0 = เดือนแรกสุดของกราฟ
      const value = BASELINE * Math.exp(-step * 0.085);
      out.push({
        label: MONTHS[d.getMonth()],
        month: d.getMonth(),
        year: d.getFullYear(),
        value: Math.round(value * 10) / 10,
      });
    }
    return out;
  }

  /** สรุปตัวเลขหลัก: ลดลงกี่ % เทียบเดือนแรกของกราฟ และเทียบเส้นฐานก่อนใช้แอป */
  function summary(months = 6) {
    const data = series(months);
    const first = data[0].value;
    const last = data[data.length - 1].value;
    const prev = data[data.length - 2]?.value ?? first;

    return {
      data,
      baseline: BASELINE,
      current: last,
      // ลดลงเทียบกับเดือนแรกที่แสดงในกราฟ = ตัวเลขพาดหัว
      reductionPct: Math.round(((first - last) / first) * 1000) / 10,
      // เทียบเดือนก่อนหน้า ใช้บอกแนวโน้มล่าสุด
      monthOverMonthPct: Math.round(((prev - last) / prev) * 1000) / 10,
      months,
    };
  }

  /**
   * สัดส่วนการมีส่วนร่วมของผู้ใช้ในเครื่องนี้ ใช้เป็นบริบทข้างตัวเลขใหญ่
   * ส่วนนี้นับจากข้อมูลจริงในแอป ไม่ใช่ข้อมูลสาธิต
   */
  function contribution() {
    const reports = window.Store.state.reports;
    const mine = reports.filter((r) => r.mine).length;
    const confirms = reports.reduce((sum, r) => sum + r.confirms, 0);
    return { reports: reports.length, mine, confirms };
  }

  return { series, summary, contribution, BASELINE };
})();
