// Test set for the panel-detection regression run (see README.md in this folder).
// style/rtl are what the app passes for that book: manga books are read with Manga mode on.
module.exports = [
  ...[1, 2, 3, 4, 5, 6].map(n => ({
    id: `W00${n}`,
    path: `C:\\Users\\Eon\\Downloads\\Wolverine (2024)\\Wolverine 00${n} (${n <= 2 ? 2024 : 2025}) (digital) (Marika-Empire).cbz`,
    style: 'comic', rtl: false,
  })),
  {
    id: 'USM', // held out: mostly framed panels on white gutters, some black-gutter pages
    path: 'C:\\Users\\Eon\\Downloads\\Ultimate Spider-Man Omnibus v01 (2022) (HD-WebRip).cbz',
    style: 'comic', rtl: false,
  },
  ...[1, 2].map(n => ({
    id: `BC0${n}`,
    path: `D:\\Downloads\\Black Clover (Digital) (DigitalMangaFan)\\Black Clover v0${n} (2016) (Digital) (DigitalMangaFan).cbz`,
    style: 'manga', rtl: true,
  })),
  {
    id: 'BK01', // dense, irregular manga layouts; bubble reading-order problems reported here
    path: 'D:\\Downloads\\Berserk (Digital) (danke-Empire)\\Berserk v01 (2003) (Digital) (danke-Empire).cbz',
    style: 'manga', rtl: true,
  },
];
