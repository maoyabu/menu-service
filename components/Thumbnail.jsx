import React from 'react';

const Thumbnail = (props) => {
  const { record } = props;
  const imageUrl = record.params.url;

  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {imageUrl && (
        <img src={imageUrl} alt="thumb" style={{ width: 100, height: 80, objectFit: 'cover', marginRight: '1rem', borderRadius: '4px' }} />
      )}
      <span>{record.params.name}</span>
    </div>
  );
};

export default Thumbnail;